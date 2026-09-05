// Hub 主备切换的数据模型：切换计划、按钮态、请求层（`HubRoleIo`）与全部文案。
// 状态机在 `./hub-role-switch-run`，React 绑定在 `./use-hub-role-switch`。

import { type HubApi, defaultHubApi } from '@/node/hub-api';
import { getMeshHubsState, refreshMeshHubs } from '@/node/mesh-hubs';
import type { NodeRow } from '@/node/mesh-nodes';
import { defaultApiClient } from '@tmex/api-client';
import type { HubAuthorizationKind, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { errorMessage, sleepOrAbort } from '@tmex/shared';
import type { HubRoleErrorCode, HubRoleRequest, HubRoleTransitionPhase } from '@tmex/shared';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  encodeBase64url,
} from '@tmex/shared/auth';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 轮询间隔：目标重启期间每一拍都是一次注定失败的请求，不必太密。 */
export const HUB_ROLE_POLL_MS = 2000;
/** 目标重启期间允许连续不可达多久；超出即判失败，不再空等。 */
export const HUB_ROLE_RESTART_BUDGET_MS = 90_000;
/** 等 `admit-hub` 在 `/api/mesh/hubs` 上生效的上限。 */
export const HUB_ROLE_AUTH_TIMEOUT_MS = 20_000;
/** 等 `writerHubId` 换成目标的上限；目标重启完成后这一步通常只要一两拍。 */
export const HUB_ROLE_WRITER_TIMEOUT_MS = 60_000;
/** 续跑前读一次 `/api/mesh/hubs` 的重试上限：入口在切换期间可能短暂断连，但不能无限等。 */
export const HUB_ROLE_HUBS_TIMEOUT_MS = 20_000;

export const HUB_ROLE_SWITCH_KEY = 'tmex.nodes.hub-role-switch';
/** 超过这个时长的记录一律作废：目标早该起来了，接着轮询只会对着一份陈旧的 operationId。 */
export const HUB_ROLE_SWITCH_TTL_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

/** 计划里引用到的一台 hub；名字取节点表的那一份，与表里显示的一致。 */
export interface HubRef {
  nodeId: string;
  name: string;
  publicUrl: string;
  priority: number;
  writerEpoch: number;
  online: boolean;
  /** 旧后端不下发时为 `undefined`——此时不知道要不要签授权，按钮直接禁用。 */
  authorization?: HubAuthorizationKind;
}

export interface HubRoleSwitchPlan {
  /** 点的那一行。 */
  origin: HubRef;
  /** 「设为主 Hub」= 升 origin；「设为备 Hub」= 降 origin 并让 target 接管。 */
  intent: 'promote' | 'demote';
  /** 切换后的主 hub；降备且没有别的可接管的 hub 时为 `null`。 */
  target: HubRef | null;
  /** 当前 writer；一台都没有时为 `null`。 */
  from: HubRef | null;
  /** 目标还没有签名授权，须先签一条 `admit-hub`。 */
  needsAdmit: boolean;
  /** 原主不可达：跳过降备那一步，靠更高纪元围栏它。 */
  fromUnreachable: boolean;
  /** 切换后没有任何可写 hub（降备且无人接管）。 */
  leavesNoWriter: boolean;
}

function hubRefOf(hub: MeshHubEndpoint, nameOf: (nodeId: string) => string): HubRef {
  return {
    nodeId: hub.nodeId,
    name: nameOf(hub.nodeId),
    publicUrl: hub.publicUrl,
    priority: hub.priority,
    writerEpoch: hub.writerEpoch,
    online: hub.online !== false,
    authorization: hub.authorization,
  };
}

/**
 * 降备时挑谁接管：只认已授权且在线的 hub，签名授权优先，其次优先级小的（越小越先）。
 * 一台都挑不出来时返回 `null`——切换仍然允许，但确认框会写明「之后将没有可写 Hub」。
 */
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

export interface HubRolePlanInput {
  row: NodeRow;
  hubs: MeshHubEndpoint[];
  writerHubId: string | null;
  nameOf?: (nodeId: string) => string;
}

/** 集合里没有这一行对应的 hub（旧入口 / 首屏还没拉到）时返回 `null`，按钮据此禁用。 */
export function planHubRoleSwitch(input: HubRolePlanInput): HubRoleSwitchPlan | null {
  const nameOf = input.nameOf ?? ((nodeId: string) => nodeId.slice(0, 8));
  const self = input.hubs.find((hub) => hub.nodeId === input.row.id);
  if (!self) return null;
  const origin = hubRefOf(self, nameOf);
  const writer = input.hubs.find((hub) => hub.nodeId === input.writerHubId) ?? null;
  const intent: 'promote' | 'demote' = input.row.id === input.writerHubId ? 'demote' : 'promote';
  const successor = intent === 'demote' ? pickSuccessorHub(input.hubs, origin.nodeId) : self;
  const target = successor ? hubRefOf(successor, nameOf) : null;
  const from = writer ? hubRefOf(writer, nameOf) : null;
  return {
    origin,
    intent,
    target,
    from,
    needsAdmit: target !== null && target.authorization !== 'signed',
    fromUnreachable: from !== null && !from.online,
    leavesNoWriter: target === null,
  };
}

export type HubRoleBlockReason =
  | 'unknownHub'
  | 'unknownAuth'
  | 'offline'
  | 'switching'
  | 'rowBusy'
  | 'notWritable';

export interface HubRoleButtonInput extends HubRolePlanInput {
  /** hub 当前接受管理写入；只有需要签 `admit-hub` 时才拦。 */
  hubWritable: boolean;
  /** 已有一次切换在进行。 */
  switching: boolean;
  /** 这一行正在升级或卸载。 */
  rowBusy: boolean;
}

export interface HubRoleButtonState {
  intent: 'promote' | 'demote';
  plan: HubRoleSwitchPlan | null;
  blocked: HubRoleBlockReason | null;
}

export function hubRoleBlockReason(
  input: HubRoleButtonInput,
  plan: HubRoleSwitchPlan | null
): HubRoleBlockReason | null {
  if (!plan) return 'unknownHub';
  if (!plan.origin.authorization) return 'unknownAuth';
  if (!input.row.online) return 'offline';
  if (input.switching) return 'switching';
  if (input.rowBusy) return 'rowBusy';
  // 签 `admit-hub` 走 `POST /api/auth/keylog?hub=sync`，主 hub 收不下写入时这一步必然失败。
  if (plan.needsAdmit && !input.hubWritable) return 'notWritable';
  return null;
}

export function hubRoleButtonState(input: HubRoleButtonInput): HubRoleButtonState {
  const plan = planHubRoleSwitch(input);
  const intent = plan?.intent ?? (input.row.id === input.writerHubId ? 'demote' : 'promote');
  return { intent, plan, blocked: hubRoleBlockReason(input, plan) };
}

// ---------------------------------------------------------------------------
// 请求层
// ---------------------------------------------------------------------------

/** 版本低于 `MIN_HUB_AUTH_RECORD_VERSION`、挡住 `admit-hub` 的一台节点。 */
export interface UnsupportedKeyLogNode {
  id: string;
  name: string;
  version: string | null;
}

export type AdmitHubOutcome =
  | { kind: 'ok' }
  | { kind: 'unsupportedNodes'; minVersion: string; nodes: UnsupportedKeyLogNode[] }
  | { kind: 'failed'; code: string };

/** `unreachable`：目标暂时打不通（重启中 / 网络抖动），按「继续等」处理，不是结论。 */
export type HubRoleOutcome =
  | { kind: 'ok'; phase: HubRoleTransitionPhase; error: string | null }
  | { kind: 'unreachable' }
  | { kind: 'failed'; code: string };

export interface HubsSnapshot {
  hubs: MeshHubEndpoint[];
  writerHubId: string | null;
}

/** 状态机与真实请求之间的接缝：单测注入假实现，不碰网络与计时器。 */
export interface HubRoleIo {
  /** `POST /api/auth/keylog?hub=sync`；`force` 打 `X-Tmex-Force-Keylog: 1`。 */
  appendAdmitHub(
    record: { bytes: Uint8Array; sig: Uint8Array },
    force: boolean
  ): Promise<AdmitHubOutcome>;
  role(hubNodeId: string, req: HubRoleRequest): Promise<HubRoleOutcome>;
  roleStatus(hubNodeId: string, operationId: string): Promise<HubRoleOutcome>;
  hubs(): Promise<HubsSnapshot>;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  now(): number;
}

function parseUnsupportedNodes(value: unknown): UnsupportedKeyLogNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: UnsupportedKeyLogNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const node = item as Partial<UnsupportedKeyLogNode>;
    if (typeof node.id !== 'string') continue;
    nodes.push({
      id: node.id,
      name: typeof node.name === 'string' ? node.name : node.id.slice(0, 8),
      version: typeof node.version === 'string' ? node.version : null,
    });
  }
  return nodes;
}

/**
 * `admit-hub` 不能走 `AuthApi.appendKeyLog`：那条路只回一个 code，而这里既要读 409 里的
 * `{minVersion, nodes}` 把老节点列出来，也要能补一个强制头重发。
 */
export async function submitAdmitHubRecord(
  record: { bytes: Uint8Array; sig: Uint8Array },
  force: boolean,
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response> = (path, init) =>
    defaultApiClient.fetch(path, init)
): Promise<AdmitHubOutcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (force) headers['X-Tmex-Force-Keylog'] = '1';
  let res: Response;
  try {
    res = await fetchImpl('/api/auth/keylog?hub=sync', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bytes: encodeBase64url(record.bytes),
        sig: encodeBase64url(record.sig),
      }),
    });
  } catch {
    return { kind: 'failed', code: 'NODE_UNREACHABLE' };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (res.ok) {
    // hub 没确认就等于一条都没落库：授权并没有生效，绝不能接着往下升主。
    if (body?.hubAck !== true) {
      const hubError = typeof body?.hubError === 'string' ? body.hubError : '';
      return { kind: 'failed', code: hubError || 'HUB_UNCONFIRMED' };
    }
    return { kind: 'ok' };
  }
  const code =
    typeof body?.code === 'string'
      ? body.code
      : typeof body?.error === 'string'
        ? body.error
        : 'KEY_LOG_REJECTED';
  if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) {
    return {
      kind: 'unsupportedNodes',
      minVersion:
        typeof body?.minVersion === 'string' ? body.minVersion : MIN_HUB_AUTH_RECORD_VERSION,
      nodes: parseUnsupportedNodes(body?.nodes),
    };
  }
  return { kind: 'failed', code };
}

function roleOutcomeOf(err: unknown): HubRoleOutcome {
  const code = errorMessage(err);
  const status = (err as { status?: unknown })?.status;
  // 5xx / 网络异常是「暂时打不通」，4xx 才是结论。
  if (typeof status !== 'number' || status >= 500) return { kind: 'unreachable' };
  return { kind: 'failed', code };
}

export function createHubRoleIo(hubApi: HubApi = defaultHubApi): HubRoleIo {
  return {
    appendAdmitHub: (record, force) => submitAdmitHubRecord(record, force),
    async role(hubNodeId, req) {
      try {
        const transition = await hubApi.role(hubNodeId, req);
        return { kind: 'ok', phase: transition.phase, error: transition.error };
      } catch (err) {
        return roleOutcomeOf(err);
      }
    },
    async roleStatus(hubNodeId, operationId) {
      try {
        const transition = await hubApi.roleStatus(hubNodeId, operationId);
        return { kind: 'ok', phase: transition.phase, error: transition.error };
      } catch (err) {
        return roleOutcomeOf(err);
      }
    },
    async hubs() {
      await refreshMeshHubs();
      const snapshot = getMeshHubsState();
      return { hubs: snapshot.hubs, writerHubId: snapshot.writerHubId };
    },
    wait: sleepOrAbort,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

const HUB_ROLE_ERROR_KEYS: Record<HubRoleErrorCode, string> = {
  HUB_NOT_HUB: 'nodes.hubs.role.errors.HUB_NOT_HUB',
  HUB_NOT_AUTHORIZED: 'nodes.hubs.role.errors.HUB_NOT_AUTHORIZED',
  HUB_EPOCH_STALE: 'nodes.hubs.role.errors.HUB_EPOCH_STALE',
  HUB_ROLE_BUSY: 'nodes.hubs.role.errors.HUB_ROLE_BUSY',
  HUB_ROLE_UNSUPPORTED: 'nodes.hubs.role.errors.HUB_ROLE_UNSUPPORTED',
  INVALID_REQUEST: 'nodes.hubs.role.errors.INVALID_REQUEST',
};

/** 稳定错误码走文案表，其余原样显示——后端加了新码也不至于弹一句空话。 */
export function hubRoleErrorText(t: Translate, code: string): string {
  const key = HUB_ROLE_ERROR_KEYS[code as HubRoleErrorCode];
  return key ? t(key) : code;
}

export function hubRoleFailedText(t: Translate, code: string): string {
  return t('nodes.hubs.role.failed', { error: hubRoleErrorText(t, code) });
}

/** 前端自己判定的失败（入口读不到、切换途中抛异常）：后端没有对应错误码，直接取本地文案。 */
export function hubRoleLocalFailedText(
  t: Translate,
  key: 'hubsUnreachable' | 'unexpected'
): string {
  return t('nodes.hubs.role.failed', { error: t(`nodes.hubs.role.errors.${key}`) });
}

const BLOCK_KEYS: Record<HubRoleBlockReason, string> = {
  unknownHub: 'nodes.hubs.role.blocked.unknownHub',
  unknownAuth: 'nodes.hubs.role.blocked.unknownAuth',
  offline: 'nodes.hubs.role.blocked.offline',
  switching: 'nodes.hubs.role.blocked.switching',
  rowBusy: 'nodes.hubs.role.blocked.rowBusy',
  notWritable: 'nodes.hubs.role.blocked.notWritable',
};

export function hubRoleBlockedText(t: Translate, reason: HubRoleBlockReason): string {
  return t(BLOCK_KEYS[reason]);
}

/** 确认框正文：一步一行，把要做的事按顺序摆出来。 */
export function hubRoleSteps(t: Translate, plan: HubRoleSwitchPlan): string[] {
  const steps: string[] = [];
  const target = plan.target?.name ?? '';
  if (plan.needsAdmit && plan.target) steps.push(t('nodes.hubs.role.stepAdmit', { target }));
  if (plan.from && !plan.fromUnreachable) {
    steps.push(t('nodes.hubs.role.stepDemote', { from: plan.from.name }));
  }
  if (plan.target) {
    steps.push(t('nodes.hubs.role.stepPromote', { target }));
    steps.push(t('nodes.hubs.role.stepWait', { target }));
  } else {
    steps.push(t('nodes.hubs.role.stepDemoteOnly', { from: plan.origin.name }));
  }
  return steps;
}

/** 确认框里的警示行：原主不可达、切完没有可写 hub。 */
export function hubRoleWarnings(t: Translate, plan: HubRoleSwitchPlan): string[] {
  const warnings: string[] = [];
  if (plan.fromUnreachable) warnings.push(t('nodes.hubs.role.warnFromUnreachable'));
  if (plan.leavesNoWriter) warnings.push(t('nodes.hubs.role.warnNoWriter'));
  return warnings;
}
