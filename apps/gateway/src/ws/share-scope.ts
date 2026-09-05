import type { StateSnapshotPayload } from '@tmex/shared';
import type { ShareScope } from '@tmex/shared/share';

/** 分享连接的可见范围：一个 tmux window（tab）及其 pane。 */
export type { ShareScope };

const paneWindowIndexes = new WeakMap<StateSnapshotPayload, Map<string, string>>();

export function buildPaneWindowIndex(snapshot: StateSnapshotPayload): Map<string, string> {
  const index = new Map<string, string>();
  for (const window of snapshot.session?.windows ?? []) {
    for (const pane of window.panes) index.set(pane.id, window.id);
  }
  return index;
}

/** 快照对象在每次 metadata patch 后整体换新，因此可按对象身份缓存 pane→window 索引。 */
export function paneWindowId(
  snapshot: StateSnapshotPayload | null | undefined,
  paneId: string
): string | null {
  if (!snapshot) return null;
  let index = paneWindowIndexes.get(snapshot);
  if (!index) {
    index = buildPaneWindowIndex(snapshot);
    paneWindowIndexes.set(snapshot, index);
  }
  return index.get(paneId) ?? null;
}

export function isPaneInShareScope(
  snapshot: StateSnapshotPayload | null | undefined,
  scope: ShareScope,
  deviceId: string,
  paneId: string
): boolean {
  if (deviceId !== scope.deviceId) return false;
  return paneWindowId(snapshot, paneId) === scope.windowId;
}

/** 快照未就绪一律判定越权（fail-closed）。 */
export type SharePaneOracle = (deviceId: string, paneId: string) => boolean;
