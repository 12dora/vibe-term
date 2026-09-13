// 节点升级：POST 启动、轮询 GET，语义对齐 GUI 的 use-node-upgrade（简化为串行）。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { type UpgradeStatus, compareSemver } from '@vibeterm/shared';
import { type FlagValues, flagBool, flagString } from './args';
import { dash, rejectExtra, sleep } from './cmd';
import type { CliContext } from './context';
import { AuthError, UsageError } from './errors';
import { type CookieJar, loginRequiredError } from './http';
import { findMeshNode, listMeshNodesFull } from './nodes-hub';
import { isLiveNodeSession } from './session-store';

export interface UpgradeLatest {
  latestVersion: string;
  changelog: string | null;
  publishedAt: string | null;
}

export interface UpgradeOutcome {
  node: string;
  name: string;
  outcome: 'done' | 'failed' | 'timeout' | 'alreadyLatest' | 'cancelled' | 'unconfirmed';
  version?: string | null;
  error?: string;
  hint?: string;
}

/** 首个网关暴露远程升级的版本；更早的版本只能在本机手动升级。 */
export const MIN_REMOTE_UPGRADE_VERSION = '1.1.0';

const POLL_MS = 2000;
const BUDGET_MS = 6 * 60_000;
const START_GRACE_MS = 30_000;

export async function fetchUpgradeLatest(ctx: CliContext): Promise<UpgradeLatest> {
  return ctx.http.json<UpgradeLatest>(SELF_NODE_ID, 'GET', '/api/mesh/upgrade/latest');
}

function upgradePath(nodeId: string): string {
  return `/api/mesh/nodes/${nodeId}/upgrade`;
}

function nodeCookieOpts(nodeId: string) {
  return { withNodeCookies: [nodeId] as const };
}

async function readUpgradeFailure(nodeId: string, response: Response): Promise<string> {
  let body = '';
  try {
    body = (await response.text()).trim();
  } catch {
    body = '';
  }
  if (response.status === 401) throw loginRequiredError(nodeId, body);
  try {
    const payload = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 落到通用码
  }
  return 'UPGRADE_FAILED';
}

export async function startNodeUpgrade(
  ctx: CliContext,
  nodeId: string,
  version?: string
): Promise<{ kind: 'started' | 'alreadyLatest' | 'unconfirmed' | 'failed'; code?: string }> {
  const response = await ctx.http.fetch(SELF_NODE_ID, upgradePath(nodeId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(version ? { version } : {}),
    ...nodeCookieOpts(nodeId),
  });
  if (response.ok) return { kind: 'started' };
  const code = await readUpgradeFailure(nodeId, response);
  if (code === 'UPGRADE_ALREADY_LATEST') return { kind: 'alreadyLatest', code };
  if (code === 'NODE_UNREACHABLE') return { kind: 'unconfirmed', code };
  return { kind: 'failed', code };
}

export async function pollNodeUpgrade(
  ctx: CliContext,
  nodeId: string
): Promise<{ kind: 'status' | 'unreachable' | 'failed'; status?: UpgradeStatus; code?: string }> {
  const response = await ctx.http.fetch(SELF_NODE_ID, upgradePath(nodeId), nodeCookieOpts(nodeId));
  if (response.ok) {
    return { kind: 'status', status: (await response.json()) as UpgradeStatus };
  }
  if (response.status >= 500) return { kind: 'unreachable' };
  return { kind: 'failed', code: await readUpgradeFailure(nodeId, response) };
}

export async function cancelNodeUpgrade(
  ctx: CliContext,
  nodeId: string
): Promise<{ kind: 'cancelled' | 'failed'; code?: string }> {
  const response = await ctx.http.fetch(SELF_NODE_ID, upgradePath(nodeId), {
    method: 'DELETE',
    ...nodeCookieOpts(nodeId),
  });
  if (response.ok) return { kind: 'cancelled' };
  return { kind: 'failed', code: await readUpgradeFailure(nodeId, response) };
}

function versionOf(nodes: MeshNode[], nodeId: string): string | null | undefined {
  const row = nodes.find((node) => node.id === nodeId);
  return row ? row.version : undefined;
}

function outcome(
  node: MeshNode,
  kind: UpgradeOutcome['outcome'],
  extra: { version?: string | null; error?: string; hint?: string } = {}
): UpgradeOutcome {
  return { node: node.id, name: node.name, outcome: kind, ...extra };
}

function authFailureOutcome(node: MeshNode, error: AuthError): UpgradeOutcome {
  return outcome(node, 'failed', {
    error: error.code ?? 'NODE_LOGIN_REQUIRED',
    hint: error.hint,
  });
}

function pollTerminal(
  node: MeshNode,
  poll: Awaited<ReturnType<typeof pollNodeUpgrade>>
): UpgradeOutcome | 'busy' | null {
  if (poll.kind === 'failed') return outcome(node, 'failed', { error: poll.code });
  if (poll.kind !== 'status' || !poll.status) return null;
  if (poll.status.error === 'UPGRADE_CANCELLED') return outcome(node, 'cancelled');
  if (poll.status.state === 'downloading' || poll.status.state === 'executing') return 'busy';
  if (poll.status.state === 'idle' && poll.status.error) {
    return outcome(node, 'failed', { error: poll.status.error });
  }
  return null;
}

async function versionOutcome(
  ctx: CliContext,
  node: MeshNode,
  latestVersion: string | null,
  sawBusy: boolean
): Promise<UpgradeOutcome | null> {
  const roster = await listMeshNodesFull(ctx).catch(() => [] as MeshNode[]);
  const current = versionOf(roster, node.id);
  if (latestVersion && current === latestVersion)
    return outcome(node, 'done', { version: current });
  if (sawBusy && current && current !== node.version)
    return outcome(node, 'done', { version: current });
  return null;
}

export async function waitNodeUpgrade(
  ctx: CliContext,
  node: MeshNode,
  latestVersion: string | null,
  versionFlag?: string
): Promise<UpgradeOutcome> {
  const started = Date.now();
  const start = await startNodeUpgrade(ctx, node.id, versionFlag);
  if (start.kind === 'alreadyLatest')
    return outcome(node, 'alreadyLatest', { version: node.version });
  if (start.kind === 'failed') return outcome(node, 'failed', { error: start.code });
  if (start.kind === 'unconfirmed') return outcome(node, 'unconfirmed', { error: start.code });
  let sawBusy = false;
  while (Date.now() - started < BUDGET_MS) {
    const poll = await pollNodeUpgrade(ctx, node.id);
    const terminal = pollTerminal(node, poll);
    if (terminal === 'busy') {
      sawBusy = true;
      ctx.out.info(`${node.name}: ${poll.status?.state} ${dash(poll.status?.targetVersion)}`);
      await sleep(POLL_MS);
      continue;
    }
    if (terminal) return terminal;
    const done = await versionOutcome(ctx, node, latestVersion, sawBusy);
    if (done) return done;
    if (!sawBusy && Date.now() - started > START_GRACE_MS) return outcome(node, 'timeout');
    await sleep(POLL_MS);
  }
  return outcome(node, 'timeout');
}

export function orderUpgradeGroups(rows: MeshNode[], selfId?: string): MeshNode[][] {
  const others: MeshNode[] = [];
  const hubs: MeshNode[] = [];
  const self: MeshNode[] = [];
  for (const row of rows) {
    if (selfId && row.id === selfId) self.push(row);
    else if (row.isHub) hubs.push(row);
    else others.push(row);
  }
  return [others, hubs, self].filter((group) => group.length > 0);
}

export function orderUpgradeTargets(rows: MeshNode[], selfId?: string): MeshNode[] {
  return orderUpgradeGroups(rows, selfId).flat();
}

function isTooOldForRemoteUpgrade(version: string | null): boolean {
  if (!version) return false;
  return compareSemver(version, MIN_REMOTE_UPGRADE_VERSION) === -1;
}

/** roster 的 `loggedIn` 是入口看到的**本次请求** cookie；CLI 还要看本地 jar。 */
export function hasCliNodeSession(jar: CookieJar, nodeId: string, now = Date.now()): boolean {
  return isLiveNodeSession(jar.get(nodeId), now);
}

/** 批量升级候选：在线、已登录（CLI jar 或 roster；本机除外）、版本可解析且严格低于 latest。 */
export function isBatchEligible(
  node: MeshNode,
  latestVersion: string | null,
  selfId?: string,
  hasCliSession?: (nodeId: string) => boolean
): boolean {
  if (!latestVersion || !node.version) return false;
  if (!node.online) return false;
  const isSelf = Boolean(selfId && node.id === selfId);
  if (!isSelf && !node.loggedIn && !hasCliSession?.(node.id)) return false;
  if (isTooOldForRemoteUpgrade(node.version)) return false;
  return compareSemver(node.version, latestVersion) === -1;
}

function startOutcome(
  node: MeshNode,
  start: Awaited<ReturnType<typeof startNodeUpgrade>>
): UpgradeOutcome {
  if (start.kind === 'alreadyLatest') {
    return outcome(node, 'alreadyLatest', { version: node.version, error: start.code });
  }
  if (start.kind === 'failed') return outcome(node, 'failed', { error: start.code });
  if (start.kind === 'unconfirmed') return outcome(node, 'unconfirmed', { error: start.code });
  return outcome(node, 'done', { error: start.code });
}

async function upgradeOneNode(
  ctx: CliContext,
  node: MeshNode,
  latestVersion: string | null,
  versionFlag: string | undefined,
  wait: boolean
): Promise<UpgradeOutcome> {
  if (wait) return waitNodeUpgrade(ctx, node, latestVersion, versionFlag);
  return startOutcome(node, await startNodeUpgrade(ctx, node.id, versionFlag));
}

export async function runUpgradeBatch(
  ctx: CliContext,
  targets: MeshNode[],
  latestVersion: string | null,
  versionFlag?: string,
  wait = false,
  selfId?: string
): Promise<UpgradeOutcome[]> {
  const outcomes: UpgradeOutcome[] = [];
  // 多节点时单台 401 记进该行结果，不丢掉已收集的 outcome、也不跳过后面的节点。
  const isolateAuth = targets.length > 1;
  for (const group of orderUpgradeGroups(targets, selfId)) {
    for (const node of group) {
      try {
        outcomes.push(await upgradeOneNode(ctx, node, latestVersion, versionFlag, wait));
      } catch (error) {
        if (isolateAuth && error instanceof AuthError) {
          outcomes.push(authFailureOutcome(node, error));
          continue;
        }
        throw error;
      }
    }
  }
  return outcomes;
}

export function upgradeExitCode(outcomes: UpgradeOutcome[]): number {
  const bad = new Set(['failed', 'timeout', 'unconfirmed']);
  return outcomes.some((row) => bad.has(row.outcome)) ? 1 : 0;
}

export function uninstallPath(nodeId: string): string {
  return `/api/mesh/nodes/${nodeId}/uninstall`;
}

export function parseUpgradeIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new UsageError('--ids is empty');
  return ids;
}

export interface UpgradeInvocation {
  all: boolean;
  ids: string[];
  wait: boolean;
  version: string | undefined;
  nodeRef: string | undefined;
}

export function parseUpgradeInvocation(
  flags: FlagValues,
  positionals: string[]
): UpgradeInvocation {
  const all = flagBool(flags, 'all');
  const idsRaw = flagString(flags, 'ids');
  const ids = idsRaw ? parseUpgradeIds(idsRaw) : [];
  const subset = ids.length > 0;
  if (all && subset) throw new UsageError('--all and --ids cannot be combined');
  if ((all || subset) && positionals[0]) {
    throw new UsageError('--all/--ids does not take a node argument');
  }
  if (!all && !subset && !positionals[0]) {
    throw new UsageError('missing node (or pass --all / --ids)');
  }
  rejectExtra(positionals, all || subset ? 0 : 1);
  return {
    all,
    ids,
    wait: all || subset || flagBool(flags, 'wait'),
    version: flagString(flags, 'version'),
    nodeRef: positionals[0],
  };
}

export async function selectUpgradeTargets(
  ctx: CliContext,
  options: {
    all: boolean;
    ids: string[];
    nodeRef?: string;
    latestVersion: string | null;
    selfId?: string;
  }
): Promise<MeshNode[]> {
  const roster = await listMeshNodesFull(ctx);
  const eligible = (node: MeshNode) =>
    node.paused !== true &&
    isBatchEligible(node, options.latestVersion, options.selfId, (id) =>
      hasCliNodeSession(ctx.http.jar, id)
    );
  if (options.all) return roster.filter(eligible);
  if (options.ids.length > 0) {
    const wanted: MeshNode[] = [];
    for (const ref of options.ids) {
      wanted.push(await findMeshNode(ctx, ref));
    }
    return wanted.filter(eligible);
  }
  if (!options.nodeRef) throw new UsageError('missing node (or pass --all / --ids)');
  return [await findMeshNode(ctx, options.nodeRef)];
}
