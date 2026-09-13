// 暂停资格：本机、待批准、Hub、当前浏览器转发路径上的节点都不能暂停。
// 恢复：本机与待批准不可恢复；已暂停的 Hub / 当前转发节点可以恢复（升级前误暂停的 Hub 必须有出路）。
// 行菜单与批量动作共用 pause-inflight，在途节点从资格里剔除。

import { isMeshNodePaused } from '@/node/merge-nodes';
import type { NodeRow } from '@/node/mesh-nodes';
import { isPauseInflight } from './pause-inflight';

export type PauseAction = 'pause' | 'resume';
export type PauseBlockReason = 'self' | 'pending' | 'hub' | 'forwarder';

const FORWARDER_PREFIX = /^\/n\/([^/]+)/;

export function forwarderNodeIdFromPath(pathname: string): string | null {
  const match = pathname.match(FORWARDER_PREFIX);
  if (!match) return null;
  const id = decodeURIComponent(match[1] ?? '');
  if (!id || id === 'self') return null;
  return id;
}

export function isCurrentForwarderNode(
  row: Pick<NodeRow, 'id' | 'runtimeNodeId'>,
  pathname: string
): boolean {
  const current = forwarderNodeIdFromPath(pathname);
  if (!current) return false;
  return row.id === current || row.runtimeNodeId === current;
}

export function pauseBlockReason(
  row: Pick<NodeRow, 'id' | 'runtimeNodeId' | 'isSelf' | 'isHub' | 'pending'>,
  pathname: string,
  action: PauseAction = 'pause'
): PauseBlockReason | null {
  if (row.isSelf) return 'self';
  if (row.pending === true) return 'pending';
  if (action === 'resume') return null;
  if (row.isHub) return 'hub';
  if (isCurrentForwarderNode(row, pathname)) return 'forwarder';
  return null;
}

export function isPauseEligible(
  row: Pick<NodeRow, 'id' | 'runtimeNodeId' | 'isSelf' | 'isHub' | 'pending'>,
  pathname: string,
  action: PauseAction = 'pause'
): boolean {
  return pauseBlockReason(row, pathname, action) === null;
}

const BLOCK_KEYS: Record<Exclude<PauseBlockReason, 'pending'>, string> = {
  self: 'nodes.pause.selfBlocked',
  hub: 'nodes.pause.hubBlocked',
  forwarder: 'nodes.pause.forwarderBlocked',
};

export function pauseBlockTitle(
  reason: PauseBlockReason | null,
  t: (key: string) => string
): string | undefined {
  if (!reason || reason === 'pending') return undefined;
  return t(BLOCK_KEYS[reason]);
}

export function eligiblePauseRows(rows: readonly NodeRow[], pathname: string): NodeRow[] {
  return rows.filter(
    (row) =>
      isPauseEligible(row, pathname, 'pause') && !isMeshNodePaused(row) && !isPauseInflight(row.id)
  );
}

export function eligibleResumeRows(rows: readonly NodeRow[], pathname: string): NodeRow[] {
  return rows.filter(
    (row) =>
      isPauseEligible(row, pathname, 'resume') && isMeshNodePaused(row) && !isPauseInflight(row.id)
  );
}
