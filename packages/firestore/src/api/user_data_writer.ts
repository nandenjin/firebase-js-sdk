/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DocumentData } from '@firebase/firestore-types';

import {
  ArrayValue as ProtoArrayValue,
  LatLng as ProtoLatLng,
  MapValue as ProtoMapValue,
  Timestamp as ProtoTimestamp,
  Value as ProtoValue
} from '../protos/firestore_proto_api';
import { GeoPoint } from './geo_point';
import { Timestamp } from './timestamp';
import { DatabaseId } from '../core/database_info';
import { DocumentKey } from '../model/document_key';
import {
  normalizeByteString,
  normalizeNumber,
  normalizeTimestamp,
  typeOrder
} from '../model/values';
import {
  getLocalWriteTime,
  getPreviousValue
} from '../model/server_timestamps';
import { fail, hardAssert } from '../util/assert';
import { forEach } from '../util/obj';
import { TypeOrder } from '../model/object_value';
import { ResourcePath } from '../model/path';
import { isValidResourceName } from '../remote/serializer';
import { logError } from '../util/log';
import { ByteString } from '../util/byte_string';
import { Bytes } from '../../lite/src/api/bytes';
import { FirebaseFirestore as LiteFirebaseFirestore } from '../../lite/src/api/database';
import { FirebaseFirestore as ExpFirebaseFirestore } from '../../exp/src/api/database';
import { DocumentReference as LiteDocumentReference } from '../../lite/src/api/reference';
import { DocumentReference as ExpDocumentReference } from '../../exp/src/api/reference';
import { Blob } from './blob';
import { DocumentReference, Firestore } from './database';

export type ServerTimestampBehavior = 'estimate' | 'previous' | 'none';

/**
 * Converts Firestore's internal types to the JavaScript types that we expose
 * to the user.
 */
export abstract class AbstractUserDataWriter {
  convertValue(
    value: ProtoValue,
    serverTimestampBehavior: ServerTimestampBehavior = 'none'
  ): unknown {
    switch (typeOrder(value)) {
      case TypeOrder.NullValue:
        return null;
      case TypeOrder.BooleanValue:
        return value.booleanValue!;
      case TypeOrder.NumberValue:
        return normalizeNumber(value.integerValue || value.doubleValue);
      case TypeOrder.TimestampValue:
        return this.convertTimestamp(value.timestampValue!);
      case TypeOrder.ServerTimestampValue:
        return this.convertServerTimestamp(value, serverTimestampBehavior);
      case TypeOrder.StringValue:
        return value.stringValue!;
      case TypeOrder.BlobValue:
        return this.convertBytes(normalizeByteString(value.bytesValue!));
      case TypeOrder.RefValue:
        return this.convertReference(value.referenceValue!);
      case TypeOrder.GeoPointValue:
        return this.convertGeoPoint(value.geoPointValue!);
      case TypeOrder.ArrayValue:
        return this.convertArray(value.arrayValue!, serverTimestampBehavior);
      case TypeOrder.ObjectValue:
        return this.convertObject(value.mapValue!, serverTimestampBehavior);
      default:
        throw fail('Invalid value type: ' + JSON.stringify(value));
    }
  }

  private convertObject(
    mapValue: ProtoMapValue,
    serverTimestampBehavior: ServerTimestampBehavior
  ): DocumentData {
    const result: DocumentData = {};
    forEach(mapValue.fields || {}, (key, value) => {
      result[key] = this.convertValue(value, serverTimestampBehavior);
    });
    return result;
  }

  private convertGeoPoint(value: ProtoLatLng): GeoPoint {
    return new GeoPoint(
      normalizeNumber(value.latitude),
      normalizeNumber(value.longitude)
    );
  }

  private convertArray(
    arrayValue: ProtoArrayValue,
    serverTimestampBehavior: ServerTimestampBehavior
  ): unknown[] {
    return (arrayValue.values || []).map(value =>
      this.convertValue(value, serverTimestampBehavior)
    );
  }

  private convertServerTimestamp(
    value: ProtoValue,
    serverTimestampBehavior: ServerTimestampBehavior
  ): unknown {
    switch (serverTimestampBehavior) {
      case 'previous':
        const previousValue = getPreviousValue(value);
        if (previousValue == null) {
          return null;
        }
        return this.convertValue(previousValue, serverTimestampBehavior);
      case 'estimate':
        return this.convertTimestamp(getLocalWriteTime(value));
      default:
        return null;
    }
  }

  private convertTimestamp(value: ProtoTimestamp): Timestamp {
    const normalizedValue = normalizeTimestamp(value);
    return new Timestamp(normalizedValue.seconds, normalizedValue.nanos);
  }

  protected convertDocumentKey(
    name: string,
    expectedDatabaseId: DatabaseId
  ): DocumentKey {
    const resourcePath = ResourcePath.fromString(name);
    hardAssert(
      isValidResourceName(resourcePath),
      'ReferenceValue is not valid ' + name
    );
    const databaseId = new DatabaseId(resourcePath.get(1), resourcePath.get(3));
    const key = new DocumentKey(resourcePath.popFirst(5));

    if (!databaseId.isEqual(expectedDatabaseId)) {
      // TODO(b/64130202): Somehow support foreign references.
      logError(
        `Document ${key} contains a document ` +
          `reference within a different database (` +
          `${databaseId.projectId}/${databaseId.database}) which is not ` +
          `supported. It will be treated as a reference in the current ` +
          `database (${expectedDatabaseId.projectId}/${expectedDatabaseId.database}) ` +
          `instead.`
      );
    }
    return key;
  }

  protected abstract convertReference(name: string): unknown;

  protected abstract convertBytes(bytes: ByteString): unknown;
}

export class UserDataWriter extends AbstractUserDataWriter {
  constructor(protected firestore: Firestore) {
    super();
  }

  protected convertBytes(bytes: ByteString): Blob {
    return new Blob(bytes);
  }

  protected convertReference(name: string): DocumentReference {
    const key = this.convertDocumentKey(name, this.firestore._databaseId);
    return DocumentReference.forKey(key, this.firestore, /* converter= */ null);
  }
}

export class ExpUserDataWriter extends AbstractUserDataWriter {
  constructor(protected firestore: ExpFirebaseFirestore) {
    super();
  }

  protected convertBytes(bytes: ByteString): Bytes {
    return new Bytes(bytes);
  }

  protected convertReference(name: string): ExpDocumentReference {
    const key = this.convertDocumentKey(name, this.firestore._databaseId);
    return new ExpDocumentReference(this.firestore, /* converter= */ null, key);
  }
}

export class LiteUserDataWriter extends AbstractUserDataWriter {
  constructor(protected firestore: LiteFirebaseFirestore) {
    super();
  }

  protected convertBytes(bytes: ByteString): Bytes {
    return new Bytes(bytes);
  }

  protected convertReference(name: string): LiteDocumentReference {
    const key = this.convertDocumentKey(name, this.firestore._databaseId);
    return new LiteDocumentReference(
      this.firestore,
      /* converter= */ null,
      key
    );
  }
}
