import { wsBorsh } from '@tmex/shared';
import type { SharePaneOracle, ShareScope } from './share-scope';

export interface ShareFilterableSnapshot {
  metadataEpoch: Uint8Array;
  revision: bigint;
  records: wsBorsh.SourceMetadataRecord[];
}

export interface ShareFilterablePatch {
  metadataEpoch: Uint8Array;
  fromRevision: bigint;
  throughRevision: bigint;
  upserts: wsBorsh.SourceMetadataRecord[];
  removals: wsBorsh.SourceEntityKey[];
}

export interface ShareFilteredRecords {
  records: wsBorsh.SourceMetadataRecord[];
  /** 被移出 scope window 的 pane：要转成 removal，客户端才会把它从树里摘掉。 */
  evicted: wsBorsh.SourceEntityKey[];
}

/** 设备名 / 会话名 / pane 标题都会泄露分享范围以外的信息，按实体剥掉。 */
const IDENTITY_FIELDS = new Set<number>([
  wsBorsh.SOURCE_FIELD_NAME,
  wsBorsh.SOURCE_FIELD_CUSTOM_NAME,
]);

type RecordVerdict = 'keep' | 'anonymize' | 'drop' | 'evict';

function classifyRecord(record: wsBorsh.SourceMetadataRecord, scope: ShareScope): RecordVerdict {
  const kind = record.key.entityKind;
  if (kind === wsBorsh.SOURCE_ENTITY_DEVICE || kind === wsBorsh.SOURCE_ENTITY_SESSION) {
    return 'anonymize';
  }
  if (kind === wsBorsh.SOURCE_ENTITY_SERVER) return 'keep';
  if (kind === wsBorsh.SOURCE_ENTITY_WINDOW) {
    return record.key.nativeId === scope.windowId ? 'keep' : 'drop';
  }
  if (kind === wsBorsh.SOURCE_ENTITY_PANE) {
    return record.parent?.nativeId === scope.windowId ? 'keep' : 'evict';
  }
  return 'drop';
}

function anonymizeRecord(record: wsBorsh.SourceMetadataRecord): wsBorsh.SourceMetadataRecord {
  const fields = record.fields.filter((field) => !IDENTITY_FIELDS.has(field.field));
  return fields.length === record.fields.length ? record : { ...record, fields };
}

/**
 * device / server / session 三级实体必须保留：客户端的 legacy 投影靠 session 承载 window，
 * 少了它整棵树无法落地。名字字段在这里剥掉，结构留下。
 */
export function filterMetadataRecordsForShare(
  records: readonly wsBorsh.SourceMetadataRecord[],
  scope: ShareScope
): ShareFilteredRecords {
  const kept: wsBorsh.SourceMetadataRecord[] = [];
  const evicted: wsBorsh.SourceEntityKey[] = [];
  for (const record of records) {
    const verdict = classifyRecord(record, scope);
    if (verdict === 'keep') kept.push(record);
    else if (verdict === 'anonymize') kept.push(anonymizeRecord(record));
    else if (verdict === 'evict') evicted.push(record.key);
  }
  return { records: kept, evicted };
}

export function filterSnapshotForShare(
  snapshot: ShareFilterableSnapshot,
  scope: ShareScope
): ShareFilterableSnapshot {
  return { ...snapshot, records: filterMetadataRecordsForShare(snapshot.records, scope).records };
}

function keepRemoval(key: wsBorsh.SourceEntityKey, scope: ShareScope): boolean {
  if (key.entityKind !== wsBorsh.SOURCE_ENTITY_WINDOW) return true;
  return key.nativeId === scope.windowId;
}

/** patch 不能整条丢弃：revision 必须连续，否则客户端会判定 metadata gap 并要求重拍。 */
export function filterMetadataForShare(
  patch: ShareFilterablePatch,
  scope: ShareScope
): ShareFilterablePatch {
  const { records, evicted } = filterMetadataRecordsForShare(patch.upserts, scope);
  return {
    ...patch,
    upserts: records,
    removals: [...patch.removals.filter((key) => keepRemoval(key, scope)), ...evicted],
  };
}

/** 出站唯一收口：分享连接看到的 canonical 事件都先过这里。 */
export function filterCanonicalEventForShare(
  event: wsBorsh.CanonicalEvent,
  scope: ShareScope,
  paneInScope: SharePaneOracle
): wsBorsh.CanonicalEvent | null {
  if ('SourceMetadataSnapshot' in event) {
    const snapshot = event.SourceMetadataSnapshot;
    const { records } = filterMetadataRecordsForShare(snapshot.records, scope);
    return { SourceMetadataSnapshot: { ...snapshot, records } };
  }
  if ('SourceMetadataPatch' in event) {
    return { SourceMetadataPatch: filterMetadataForShare(event.SourceMetadataPatch, scope) };
  }
  if ('PaneData' in event) {
    const pane = event.PaneData.pane;
    return paneInScope(pane.deviceId, pane.paneId) ? event : null;
  }
  return event;
}
