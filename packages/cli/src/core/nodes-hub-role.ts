// Hub 主备远程切换：POST /n/<hub>/api/hub/role + 轮询 status，对齐 GUI hub-role-switch。

import type { MeshHubEndpoint, MeshHubsResponse, MeshNode } from '@vibeterm/api-client/auth/types';
import type { HubRoleMode, HubRoleRequest, HubRoleTransition } from '@vibeterm/shared';
import { dash, sleep } from './cmd';
import type { CliContext } from './context';
import { CliError, NotFoundError, UsageError } from './errors';
import { fetchHubs } from './nodes-hub';
import {
  type AdmitHubAppendOutcome,
  type UnsupportedKeyLogNode,
  admitHubViaKeyLog,
} from './nodes-keylog';

export const HUB_ROLE_POLL_MS = 2000;
export const HUB_ROLE_RESTART_BUDGET_MS = 90_000;
export const HUB_ROLE_AUTH_TIMEOUT_MS = 20_000;
export const HUB_ROLE_WRITER_TIMEOUT_MS = 60_000;

export type HubRoleVerb = 'promote' | 'demote' | 'standby';

export interface HubRoleRef {
  nodeId: string;
  name: string;
  publicUrl: string;
  authorization?: MeshHubEndpoint['authorization'];
  online: boolean;
  priority: number;
}

export interface HubRolePlan {
  verb: HubRoleVerb;
  origin: HubRoleRef;
  /** 切换后的 writer；`standby` / 无人接管的 demote 为 null。 */
  target: HubRoleRef | null;
  from: HubRoleRef | null;
  needsAdmit: boolean;
  fromUnreachable: boolean;
  leavesNoWriter: boolean;
}

export type HubRoleRunKind = 'done' | 'unconfirmed' | 'failed' | 'cancelled';

export interface HubRoleRunResult {
  kind: HubRoleRunKind;
  operationId: string;
  verb: HubRoleVerb;
  node: string;
  admitted?: boolean;
  phase?: string;
  writerHubId?: string | null;
  error?: string;
  unsupported?: { minVersion: string; nodes: UnsupportedKeyLogNode[] };
}

type RoleHttp =
  | { kind: 'ok'; transition: HubRoleTransition }
  | { kind: 'unreachable'; code?: string }
  | { kind: 'failed'; code: string };

function hubRefOf(hub: MeshHubEndpoint, nameOf: (id: string) => string): HubRoleRef {
  return {
    nodeId: hub.nodeId,
    name: nameOf(hub.nodeId),
    publicUrl: hub.publicUrl,
    authorization: hub.authorization,
    online: hub.online !== false,
    priority: hub.priority,
  };
}

export function pickSuccessorHub(
  hubs: MeshHubEndpoint[],
  exceptNodeId: string
): MeshHubEndpoint | null {
  const candidates = hubs
    .filter((hub) => hub.nodeId !== exceptNodeId && hub.online !== false && hub.authorization)
    .sort((a, b) => {
      const signed = Number(b.authorization === 'signed') - Number(a.authorization === 'signed');
      if (signed !== 0) return signed;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.nodeId.localeCompare(b.nodeId);
    });
  return candidates[0] ?? null;
}

export function planHubRole(input: {
  verb: HubRoleVerb;
  node: MeshNode;
  hubs: MeshHubsResponse;
  nameOf?: (id: string) => string;
}): HubRolePlan {
  const nameOf = input.nameOf ?? ((id: string) => id.slice(0, 8));
  const self = input.hubs.hubs.find((hub) => hub.nodeId === input.node.id);
  if (!self) {
    throw new NotFoundError(`${input.node.name} is not in the hub set`, 'run: vibeterm nodes hubs');
  }
  const origin = hubRefOf(self, nameOf);
  const writer = input.hubs.hubs.find((hub) => hub.nodeId === input.hubs.writerHubId) ?? null;
  const from = writer ? hubRefOf(writer, nameOf) : null;
  if (input.verb === 'standby') {
    return {
      verb: 'standby',
      origin,
      target: null,
      from,
      needsAdmit: false,
      fromUnreachable: false,
      leavesNoWriter: from?.nodeId === origin.nodeId,
    };
  }
  if (input.verb === 'promote') {
    if (from?.nodeId === origin.nodeId) {
      throw new UsageError(`${origin.name} is already the writer hub`);
    }
    return {
      verb: 'promote',
      origin,
      target: origin,
      from,
      needsAdmit: origin.authorization !== 'signed',
      fromUnreachable: from !== null && !from.online,
      leavesNoWriter: false,
    };
  }
  if (from?.nodeId !== origin.nodeId) {
    throw new UsageError(
      `${origin.name} is not the writer hub`,
      'use promote to make it writer, or standby to force standby'
    );
  }
  const successor = pickSuccessorHub(input.hubs.hubs, origin.nodeId);
  const target = successor ? hubRefOf(successor, nameOf) : null;
  return {
    verb: 'demote',
    origin,
    target,
    from,
    needsAdmit: target !== null && target.authorization !== 'signed',
    fromUnreachable: false,
    leavesNoWriter: target === null,
  };
}

function envelopeCode(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.code === 'string') return body.code;
  if (typeof body.error === 'string') return body.error;
  return fallback;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // 非 JSON
  }
  return {};
}

function classifyRoleHttp(status: number, body: Record<string, unknown>): RoleHttp {
  if (status >= 200 && status < 300) {
    return { kind: 'ok', transition: body as unknown as HubRoleTransition };
  }
  if (status === 404 || status === 405) return { kind: 'failed', code: 'HUB_ROLE_UNSUPPORTED' };
  if (status >= 500) return { kind: 'unreachable', code: envelopeCode(body, 'HTTP_5XX') };
  return { kind: 'failed', code: envelopeCode(body, `HTTP_${status}`) };
}

export async function postHubRole(
  ctx: CliContext,
  hubNodeId: string,
  req: HubRoleRequest
): Promise<RoleHttp> {
  try {
    const response = await ctx.http.fetch(hubNodeId, '/api/hub/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    return classifyRoleHttp(response.status, await readJsonBody(response));
  } catch {
    return { kind: 'unreachable' };
  }
}

export async function getHubRoleStatus(
  ctx: CliContext,
  hubNodeId: string,
  operationId: string
): Promise<RoleHttp> {
  const path = `/api/hub/role/status?operationId=${encodeURIComponent(operationId)}`;
  try {
    const response = await ctx.http.fetch(hubNodeId, path);
    return classifyRoleHttp(response.status, await readJsonBody(response));
  } catch {
    return { kind: 'unreachable' };
  }
}

function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}

function failed(
  plan: HubRolePlan,
  operationId: string,
  error: string,
  extra: Partial<HubRoleRunResult> = {}
): HubRoleRunResult {
  return {
    kind: 'failed',
    operationId,
    verb: plan.verb,
    node: plan.origin.nodeId,
    error,
    ...extra,
  };
}

function admitError(outcome: AdmitHubAppendOutcome): string {
  if (outcome.kind === 'failed') return outcome.code;
  if (outcome.kind === 'unsupportedNodes') {
    const names = outcome.nodes.map((row) => row.name).join(', ') || 'unknown';
    return `KEYLOG_TYPE_UNSUPPORTED_BY_NODES (min ${outcome.minVersion}: ${names})`;
  }
  return 'admit-hub failed';
}

async function waitSignedAuthorization(ctx: CliContext, hubNodeId: string): Promise<string | null> {
  const deadline = Date.now() + HUB_ROLE_AUTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await fetchHubs(ctx).catch(() => null);
    const hub = snapshot?.hubs.find((row) => row.nodeId === hubNodeId);
    if (hub?.authorization === 'signed') return null;
    await sleep(HUB_ROLE_POLL_MS);
  }
  return 'admit-hub authorization did not become signed in time';
}

async function awaitRoleTail(
  ctx: CliContext,
  targetHubId: string,
  operationId: string,
  log: (msg: string) => void
): Promise<{ kind: 'done' | 'failed' | 'unconfirmed'; error?: string; phase?: string }> {
  let downSince: number | null = null;
  let lastCode: string | null = null;
  const restartDeadline = () =>
    downSince !== null && Date.now() - downSince >= HUB_ROLE_RESTART_BUDGET_MS;
  while (true) {
    const status = await getHubRoleStatus(ctx, targetHubId, operationId);
    if (status.kind === 'ok') {
      downSince = null;
      const phase = status.transition.phase;
      if (phase === 'complete') break;
      if (phase === 'failed') {
        return { kind: 'failed', error: status.transition.error ?? 'role switch failed', phase };
      }
      log(`${phase} ${dash(status.transition.error)}`);
    } else {
      lastCode = status.kind === 'failed' ? status.code : (status.code ?? 'unreachable');
      downSince ??= Date.now();
      if (restartDeadline()) {
        return { kind: 'unconfirmed', error: lastCode ?? 'restart timeout' };
      }
    }
    await sleep(HUB_ROLE_POLL_MS);
  }
  const writerDeadline = Date.now() + HUB_ROLE_WRITER_TIMEOUT_MS;
  while (Date.now() < writerDeadline) {
    const snapshot = await fetchHubs(ctx).catch(() => null);
    if (snapshot?.writerHubId === targetHubId) return { kind: 'done', phase: 'complete' };
    await sleep(HUB_ROLE_POLL_MS);
  }
  return { kind: 'unconfirmed', error: 'writer timeout', phase: 'complete' };
}

async function promoteTarget(
  ctx: CliContext,
  targetHubId: string,
  operationId: string
): Promise<RoleHttp> {
  const req: HubRoleRequest = { mode: 'active', operationId };
  let posted = await postHubRole(ctx, targetHubId, req);
  if (posted.kind === 'failed' && posted.code === 'HUB_EPOCH_STALE') {
    posted = await postHubRole(ctx, targetHubId, req);
  }
  return posted;
}

async function postStandby(
  ctx: CliContext,
  hubNodeId: string,
  operationId: string
): Promise<RoleHttp> {
  return postHubRole(ctx, hubNodeId, { mode: 'standby' as HubRoleMode, operationId });
}

function httpError(result: RoleHttp): string {
  if (result.kind === 'failed') return result.code;
  return result.kind === 'unreachable' ? (result.code ?? 'unreachable') : 'role switch failed';
}

async function admitIfNeeded(
  ctx: CliContext,
  plan: HubRolePlan,
  force: boolean
): Promise<AdmitHubAppendOutcome | null> {
  if (!plan.needsAdmit || !plan.target) return null;
  if (!plan.target.authorization) {
    throw new CliError(
      'hub authorization is unknown; upgrade the entry',
      1,
      'run: vibeterm nodes hubs'
    );
  }
  return admitHubViaKeyLog(ctx, {
    hubNodeId: plan.target.nodeId,
    publicUrl: plan.target.publicUrl,
    priority: plan.target.priority,
    force,
  });
}

async function applyAdmit(
  ctx: CliContext,
  plan: HubRolePlan,
  force: boolean,
  operationId: string
): Promise<HubRoleRunResult | boolean> {
  const admit = await admitIfNeeded(ctx, plan, force);
  if (!admit) return false;
  if (admit.kind !== 'ok') {
    return failed(plan, operationId, admitError(admit), {
      unsupported: admit.kind === 'unsupportedNodes' ? admit : undefined,
    });
  }
  const stalled = await waitSignedAuthorization(ctx, plan.target?.nodeId ?? plan.origin.nodeId);
  if (stalled) return failed(plan, operationId, stalled, { admitted: true });
  return true;
}

function writerToDemote(plan: HubRolePlan): string | null {
  if (!plan.from || plan.fromUnreachable || plan.from.nodeId === plan.target?.nodeId) return null;
  return plan.from.nodeId;
}

function postedOutcome(
  plan: HubRolePlan,
  operationId: string,
  posted: RoleHttp,
  admitted: boolean
): HubRoleRunResult {
  return {
    kind: posted.kind === 'ok' ? 'done' : 'unconfirmed',
    operationId,
    verb: plan.verb,
    node: plan.origin.nodeId,
    admitted,
    phase: posted.kind === 'ok' ? posted.transition.phase : undefined,
    error: posted.kind === 'unreachable' ? httpError(posted) : undefined,
  };
}

async function finishRole(
  ctx: CliContext,
  plan: HubRolePlan,
  operationId: string,
  posted: RoleHttp,
  wait: boolean,
  targetId: string,
  admitted: boolean,
  log: (msg: string) => void
): Promise<HubRoleRunResult> {
  if (posted.kind === 'failed') return failed(plan, operationId, httpError(posted));
  if (!wait) return postedOutcome(plan, operationId, posted, admitted);
  const tail = await awaitRoleTail(ctx, targetId, operationId, log);
  const snapshot =
    tail.kind === 'done' && plan.target ? await fetchHubs(ctx).catch(() => null) : null;
  return {
    ...tail,
    operationId,
    verb: plan.verb,
    node: plan.origin.nodeId,
    admitted,
    writerHubId:
      snapshot?.writerHubId ??
      (tail.kind === 'done' && plan.target ? plan.target.nodeId : undefined),
  };
}

export async function runHubRoleSwitch(
  ctx: CliContext,
  plan: HubRolePlan,
  options: { wait: boolean; force: boolean }
): Promise<HubRoleRunResult> {
  const operationId = newOperationId();
  const log = (msg: string) => ctx.out.info(msg);
  const admitted = await applyAdmit(ctx, plan, options.force, operationId);
  if (typeof admitted !== 'boolean') return admitted;
  const fromId = writerToDemote(plan);
  if (fromId && plan.target) {
    const demoted = await postStandby(ctx, fromId, operationId);
    if (demoted.kind === 'failed') return failed(plan, operationId, httpError(demoted));
  }
  if (!plan.target) {
    return finishRole(
      ctx,
      plan,
      operationId,
      await postStandby(ctx, plan.origin.nodeId, operationId),
      options.wait,
      plan.origin.nodeId,
      admitted,
      log
    );
  }
  return finishRole(
    ctx,
    plan,
    operationId,
    await promoteTarget(ctx, plan.target.nodeId, operationId),
    options.wait,
    plan.target.nodeId,
    admitted,
    log
  );
}
