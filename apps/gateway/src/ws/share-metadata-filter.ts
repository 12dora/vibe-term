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

function entityId(key: wsBorsh.SourceEntityKey): string {
  return `${key.entityKind}\u0000${key.nativeId}`;
}

/**
 * 分享连接的出站元数据视图：记住真正下发过的实体。
 * 没暴露过的 pane / window 连 removal 都不发（否则 ID 与变更时序仍会泄露给接收者），
 * patch 本身照发以保持 revision 连续。
 */
export class ShareMetadataView {
  private readonly exposed = new Set<string>();

  constructor(private readonly scope: ShareScope) {}

  snapshot(snapshot: ShareFilterableSnapshot): ShareFilterableSnapshot {
    const { records } = filterMetadataRecordsForShare(snapshot.records, this.scope);
    this.exposed.clear();
    for (const record of records) this.exposed.add(entityId(record.key));
    return { ...snapshot, records };
  }

  patch(patch: ShareFilterablePatch): ShareFilterablePatch {
    const { records, evicted } = filterMetadataRecordsForShare(patch.upserts, this.scope);
    for (const record of records) this.exposed.add(entityId(record.key));
    const removals: wsBorsh.SourceEntityKey[] = [];
    for (const key of [...patch.removals, ...evicted]) {
      const id = entityId(key);
      if (!this.exposed.delete(id)) continue;
      removals.push(key);
    }
    return { ...patch, upserts: records, removals };
  }

  /** 出站唯一收口：分享连接看到的 canonical 事件都先过这里。 */
  filterEvent(
    event: wsBorsh.CanonicalEvent,
    paneInScope: SharePaneOracle
  ): wsBorsh.CanonicalEvent | null {
    if ('SourceMetadataSnapshot' in event) {
      const filtered = this.snapshot(event.SourceMetadataSnapshot);
      return { SourceMetadataSnapshot: { ...event.SourceMetadataSnapshot, ...filtered } };
    }
    if ('SourceMetadataPatch' in event) {
      return { SourceMetadataPatch: this.patch(event.SourceMetadataPatch) };
    }
    if ('PaneData' in event) {
      const pane = event.PaneData.pane;
      return paneInScope(pane.deviceId, pane.paneId) ? event : null;
    }
    return event;
  }
}
