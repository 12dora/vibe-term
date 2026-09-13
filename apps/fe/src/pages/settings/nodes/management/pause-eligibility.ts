// 暂停资格：本机、待批准、Hub、以及当前浏览器转发路径上的节点都不能暂停。
// 批量暂停 / 恢复只作用于通过这些规则的选中行。

import { isMeshNodePaused } from '@/node/merge-nodes';
import type { NodeRow } from '@/node/mesh-nodes';

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
  pathname: string
): PauseBlockReason | null {
  if (row.isSelf) return 'self';
  if (row.pending === true) return 'pending';
  if (row.isHub) return 'hub';
  if (isCurrentForwarderNode(row, pathname)) return 'forwarder';
  return null;
}

export function isPauseEligible(
  row: Pick<NodeRow, 'id' | 'runtimeNodeId' | 'isSelf' | 'isHub' | 'pending'>,
  pathname: string
): boolean {
  return pauseBlockReason(row, pathname) === null;
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
  return rows.filter((row) => isPauseEligible(row, pathname) && !isMeshNodePaused(row));
}

export function eligibleResumeRows(rows: readonly NodeRow[], pathname: string): NodeRow[] {
  return rows.filter((row) => isPauseEligible(row, pathname) && isMeshNodePaused(row));
}
