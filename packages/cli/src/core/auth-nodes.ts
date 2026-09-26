// `vibeterm auth` 的节点选择：和 login 一样扇出到名册，离线或低于 2.10.0 的跳过。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { compareSemver } from '@vibeterm/shared';
import { EXIT_AUTH, EXIT_GENERIC, EXIT_NETWORK } from './errors';

export interface AuthTarget {
  nodeId: string;
  name: string;
}

export type AuthSkipReason = 'offline' | 'too-old' | 'unreachable' | 'missing';

export interface AuthSkip {
  nodeId: string;
  name: string;
  reason: AuthSkipReason;
  detail: string;
}

export interface AuthCallFailure {
  nodeId: string;
  name: string;
  kind: 'auth' | 'error';
  message: string;
  hint?: string;
}

export interface ExplicitAuthNode {
  nodeId: string;
  name: string;
  row: MeshNode | null;
}

export function versionTooOld(version: string | null | undefined, minVersion: string): boolean {
  if (!version) return false;
  return compareSemver(version, minVersion) === -1;
}

export function describeSkip(skip: AuthSkip): string {
  if (skip.reason === 'offline') return `skipped ${skip.name}: offline`;
  if (skip.reason === 'unreachable') return `skipped ${skip.name}: unreachable`;
  return `skipped ${skip.name}: ${skip.detail}`;
}

function isEntry(id: string, entryId: string | null): boolean {
  return id === SELF_NODE_ID || (entryId !== null && id === entryId);
}

function tooOldDetail(version: string | null, minVersion: string): string {
  return `version ${version ?? 'unknown'} is older than ${minVersion}`;
}

function preSkip(
  node: { online?: boolean; version: string | null },
  self: boolean,
  minVersion: string
): Pick<AuthSkip, 'reason' | 'detail'> | null {
  if (!self && node.online === false) return { reason: 'offline', detail: 'offline' };
  if (versionTooOld(node.version, minVersion)) {
    return { reason: 'too-old', detail: tooOldDetail(node.version, minVersion) };
  }
  return null;
}

function planOne(
  explicit: ExplicitAuthNode,
  entryId: string | null,
  minVersion: string
): { targets: AuthTarget[]; skipped: AuthSkip[] } {
  const self = explicit.nodeId === SELF_NODE_ID || isEntry(explicit.nodeId, entryId);
  const nodeId = self ? SELF_NODE_ID : explicit.nodeId;
  const target = { nodeId, name: explicit.name };
  if (!explicit.row) return { targets: [target], skipped: [] };
  const skip = preSkip(explicit.row, self, minVersion);
  if (!skip) return { targets: [target], skipped: [] };
  return { targets: [], skipped: [{ ...target, ...skip }] };
}

export function planAuthTargets(input: {
  roster: readonly MeshNode[];
  entryId: string | null;
  explicit: ExplicitAuthNode | null;
  minVersion: string;
}): { targets: AuthTarget[]; skipped: AuthSkip[] } {
  if (input.explicit) return planOne(input.explicit, input.entryId, input.minVersion);
  if (input.roster.length === 0) {
    return { targets: [{ nodeId: SELF_NODE_ID, name: 'self' }], skipped: [] };
  }
  const targets: AuthTarget[] = [];
  const skipped: AuthSkip[] = [];
  let sawSelf = false;
  for (const node of input.roster) {
    const self = isEntry(node.id, input.entryId);
    if (self) sawSelf = true;
    const target = { nodeId: self ? SELF_NODE_ID : node.id, name: node.name };
    const skip = preSkip(node, self, input.minVersion);
    if (skip) skipped.push({ ...target, ...skip });
    else targets.push(target);
  }
  if (!sawSelf) targets.unshift({ nodeId: SELF_NODE_ID, name: 'self' });
  return { targets, skipped };
}

/** 与 login 的扇出退出码对齐：纯跳过为 0；指名一台不可达为 5；要登录为 3；其余为 1。 */
export function authFanoutExit(input: {
  explicit: boolean;
  skipped: readonly AuthSkip[];
  failures: readonly AuthCallFailure[];
  successes: number;
}): number {
  if (input.failures.some((row) => row.kind === 'error')) return EXIT_GENERIC;
  if (input.failures.some((row) => row.kind === 'auth')) return EXIT_AUTH;
  if (!input.explicit || input.successes > 0) return 0;
  const reason = input.skipped[0]?.reason;
  if (reason === 'offline' || reason === 'unreachable') return EXIT_NETWORK;
  if (reason === 'too-old' || reason === 'missing') return EXIT_GENERIC;
  return 0;
}
