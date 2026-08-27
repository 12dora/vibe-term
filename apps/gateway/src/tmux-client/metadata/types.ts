import type { wsBorsh } from '@tmex/shared';

import { bytesEqual, copyBytes } from '../../bytes';

export const DEFAULT_FLUSH_INTERVAL_MS = 8;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const MAX_UNKNOWN_PANES = 256;
export const MAX_UNKNOWN_PANE_BYTES = 256 * 1024;
export const SERVER_NATIVE_ID = 'server';

export type MetadataValue = wsBorsh.SourceMetadataValue;

export interface FieldState {
  value: MetadataValue;
  revision: bigint;
}

export interface ProjectedRecord {
  key: wsBorsh.SourceEntityKey;
  parent: wsBorsh.SourceEntityKey | null;
  parentRevision: bigint;
  entityRevision: bigint;
  fields: Map<number, FieldState>;
}

export interface PendingUpsert {
  key: wsBorsh.SourceEntityKey;
  parent: wsBorsh.SourceEntityKey | null;
  fields: Map<number, MetadataValue>;
}

export interface PaneFieldHints {
  title?: string;
  currentPath?: string;
  currentCommand?: string;
}

export interface MetadataProjectionSnapshot {
  metadataEpoch: Uint8Array;
  revision: bigint;
  records: wsBorsh.SourceMetadataRecord[];
}

export interface MetadataProjectionPatch {
  metadataEpoch: Uint8Array;
  fromRevision: bigint;
  throughRevision: bigint;
  upserts: wsBorsh.SourceMetadataRecord[];
  removals: wsBorsh.SourceEntityKey[];
}

export interface MetadataProjectionOptions {
  deviceName?: string;
  flushIntervalMs?: number;
  createEpoch?: () => Uint8Array;
  onPatch?: (patch: MetadataProjectionPatch) => void;
  onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
}

export function defaultCreateEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export { bytesEqual, copyBytes };

export function cloneKey(key: wsBorsh.SourceEntityKey): wsBorsh.SourceEntityKey {
  return { ...key, serverEpoch: copyBytes(key.serverEpoch) };
}

export function keyId(key: Pick<wsBorsh.SourceEntityKey, 'entityKind' | 'nativeId'>): string {
  return `${key.entityKind}\0${key.nativeId}`;
}

export function cloneValue(value: MetadataValue): MetadataValue {
  if ('Bytes16' in value) return { Bytes16: copyBytes(value.Bytes16) };
  if ('String' in value) return { String: value.String };
  if ('Bool' in value) return { Bool: value.Bool };
  if ('U16' in value) return { U16: value.U16 };
  if ('U32' in value) return { U32: value.U32 };
  return { Unset: {} };
}

export function valueEqual(
  left: MetadataValue | undefined,
  right: MetadataValue | undefined
): boolean {
  if (!left || !right) return left === right;
  if ('Bytes16' in left && 'Bytes16' in right) return bytesEqual(left.Bytes16, right.Bytes16);
  if ('String' in left && 'String' in right) return left.String === right.String;
  if ('Bool' in left && 'Bool' in right) return left.Bool === right.Bool;
  if ('U16' in left && 'U16' in right) return left.U16 === right.U16;
  if ('U32' in left && 'U32' in right) return left.U32 === right.U32;
  return 'Unset' in left && 'Unset' in right;
}

export function keyEqual(
  left: wsBorsh.SourceEntityKey | null,
  right: wsBorsh.SourceEntityKey | null
): boolean {
  if (!left || !right) return left === right;
  return (
    left.deviceId === right.deviceId &&
    left.entityKind === right.entityKind &&
    left.nativeId === right.nativeId &&
    bytesEqual(left.serverEpoch, right.serverEpoch)
  );
}

export function stringValue(value: string): MetadataValue {
  return { String: value };
}

export function boolValue(value: boolean): MetadataValue {
  return { Bool: value };
}

export function u16Value(value: number): MetadataValue {
  return { U16: value };
}

export function u32Value(value: number): MetadataValue {
  return { U32: value };
}

export function estimateKeyBytes(key: wsBorsh.SourceEntityKey): number {
  return 32 + key.deviceId.length * 3 + key.nativeId.length * 3;
}

export function estimateUpsertBytes(upsert: PendingUpsert): number {
  let bytes = estimateKeyBytes(upsert.key) + (upsert.parent ? estimateKeyBytes(upsert.parent) : 1);
  for (const value of upsert.fields.values()) {
    bytes += 8;
    if ('String' in value) bytes += value.String.length * 3;
    if ('Bytes16' in value) bytes += 16;
  }
  return bytes;
}

export function createRecord(source: PendingUpsert, revision: bigint): ProjectedRecord {
  return {
    key: cloneKey(source.key),
    parent: source.parent ? cloneKey(source.parent) : null,
    parentRevision: revision,
    entityRevision: revision,
    fields: new Map(
      Array.from(source.fields, ([field, value]) => [field, { value: cloneValue(value), revision }])
    ),
  };
}

export function toWireRecord(record: ProjectedRecord): wsBorsh.SourceMetadataRecord {
  return {
    key: cloneKey(record.key),
    parent: record.parent ? cloneKey(record.parent) : null,
    fields: Array.from(record.fields, ([field, state]) => ({
      field,
      value: cloneValue(state.value),
    })).sort((left, right) => left.field - right.field),
  };
}

export function upsertToWireRecord(upsert: PendingUpsert): wsBorsh.SourceMetadataRecord {
  return {
    key: cloneKey(upsert.key),
    parent: upsert.parent ? cloneKey(upsert.parent) : null,
    fields: Array.from(upsert.fields, ([field, value]) => ({
      field,
      value: cloneValue(value),
    })).sort((left, right) => left.field - right.field),
  };
}
