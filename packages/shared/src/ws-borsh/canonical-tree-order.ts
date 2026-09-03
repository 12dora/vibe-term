// canonical v1.1：设备树的用户自定义显示顺序。
//
// legacy 时代这份顺序由网关在 STATE_SNAPSHOT overlay 里直接重排数组下发（applyDeviceTreeOverlay），
// canonical 客户端只能靠额外收一条 legacy 快照把它盖回来。v1.1 起顺序作为 SOURCE_FIELD_TREE_ORDER
// 随 window / pane 记录走 metadata 通路，客户端自己重排，overlay 随之下线。
//
// 排序规则与 legacy overlay 完全一致：带序号的实体按序号升序排在前，没有序号的实体
// 保持原有顺序（即 tmux index 顺序）追加在后；已不存在的序号自动失效。

import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_TREE_ORDER,
  type SourceEntityKey,
  type SourceMetadataRecord,
} from './canonical-state';

export interface CanonicalTreeOrder {
  /** windowId → 设备内的显示序号 */
  windows: Map<string, number>;
  /** paneId → 所属 window 内的显示序号 */
  panes: Map<string, number>;
}

export function createCanonicalTreeOrder(
  records?: readonly SourceMetadataRecord[]
): CanonicalTreeOrder {
  const order: CanonicalTreeOrder = { windows: new Map(), panes: new Map() };
  if (records) applyCanonicalTreeOrderPatch(order, records, []);
  return order;
}

/** 按 metadata patch 增量更新顺序表；patch 只带变化字段，没带 TREE_ORDER 即视为未变。 */
export function applyCanonicalTreeOrderPatch(
  order: CanonicalTreeOrder,
  upserts: readonly SourceMetadataRecord[],
  removals: readonly SourceEntityKey[]
): boolean {
  let changed = false;
  for (const key of removals) {
    if (orderMapFor(order, key.entityKind)?.delete(key.nativeId)) changed = true;
  }
  for (const record of upserts) {
    const target = orderMapFor(order, record.key.entityKind);
    if (!target) continue;
    const field = record.fields.find((item) => item.field === SOURCE_FIELD_TREE_ORDER);
    if (!field) continue;
    const nativeId = record.key.nativeId;
    if ('U32' in field.value) {
      if (target.get(nativeId) === field.value.U32) continue;
      target.set(nativeId, field.value.U32);
      changed = true;
      continue;
    }
    if ('Unset' in field.value && target.delete(nativeId)) changed = true;
  }
  return changed;
}

/** 顺序未生效时返回原对象引用，便于消费侧跳过下游重算。 */
export function sortSnapshotByCanonicalTreeOrder(
  snapshot: StateSnapshotPayload,
  order: CanonicalTreeOrder
): StateSnapshotPayload {
  const session = snapshot.session;
  if (!session || (order.windows.size === 0 && order.panes.size === 0)) return snapshot;
  const sorted = sortByTreeOrder<TmuxWindow>(session.windows, order.windows, (window) => window.id);
  const windows = sorted.map((window) => {
    if (order.panes.size === 0) return window;
    const panes = sortByTreeOrder<TmuxPane>(window.panes, order.panes, (pane) => pane.id);
    return panes === window.panes ? window : { ...window, panes };
  });
  if (sorted === session.windows && windows.every((window, index) => window === sorted[index])) {
    return snapshot;
  }
  return { ...snapshot, session: { ...session, windows } };
}

function orderMapFor(order: CanonicalTreeOrder, entityKind: number): Map<string, number> | null {
  if (entityKind === SOURCE_ENTITY_WINDOW) return order.windows;
  if (entityKind === SOURCE_ENTITY_PANE) return order.panes;
  return null;
}

function sortByTreeOrder<T>(
  items: T[],
  order: ReadonlyMap<string, number>,
  idOf: (item: T) => string
): T[] {
  const ranked: Array<{ item: T; rank: number }> = [];
  const rest: T[] = [];
  for (const item of items) {
    const rank = order.get(idOf(item));
    if (rank === undefined) rest.push(item);
    else ranked.push({ item, rank });
  }
  if (ranked.length === 0) return items;
  ranked.sort((left, right) => left.rank - right.rank);
  const result = [...ranked.map((entry) => entry.item), ...rest];
  return result.every((item, index) => item === items[index]) ? items : result;
}
