// Hub 主备切换：从节点表里把某台 hub 升成主（writer），或把当前主降成备。
//
// 一次切换最多四步，顺序不能反：
//   1. 目标还不是签名授权（`authorization !== 'signed'`）→ 先签一条 `admit-hub` 并等它生效。
//      hub 授权的权威来源是 key log，env 只是 bootstrap；不签授权直接升主，目标会以
//      `HUB_NOT_AUTHORIZED` 拒绝。
//   2. 原主可达 → 先把它降成备。它不可达时跳过这一步，靠更高的 writerEpoch 围栏它——
//      纪元只增不减，旧主带着低纪元回来只会被 fence 成 standby。
//   3. 目标升主。**纪元不由前端算**：入口看到的 hub 集合可能不全，算出来的 `max+1` 反而会被
//      目标以 `HUB_EPOCH_STALE` 拒掉，而那时旧主已经降备，集群就没人写了。请求只带
//      `mode: 'active'`，由目标自己取 `max(已知纪元)+1`。
//   4. 目标落库后**自己重启**，`/n/<目标>/api/...` 会断一段时间：轮询 `roleStatus` 时把不可达
//      当成「重启中」继续等，只有超出预算才判失败；随后再等入口的 `/api/mesh/hubs` 把
//      `writerHubId` 换成目标，这才算真的接管了写入。
//
// 「降原主」和「升目标」之间有一个集群没有 writer 的窗口，切换又跨越目标的一次重启，用户很可能
// 在中途刷新页面：**任何一个改动请求发出去之前**先把 `{operationId, targetHubId, fromHubId,
// intent, phase}` 落 sessionStorage，刷新后按 phase 接着跑（含重发那条幂等的升主请求）。
// 升主真的失败时不只弹一条 toast——那会让集群悄悄停在没有 writer 的状态——而是留一个不会自动
// 消失的恢复对话框，让用户重试目标或回滚回原主。
// 记录只在这一个标签页里，换标签页看不到：它不是锁，只是「刷新即丢」的补丁。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import type { RecordSigner } from '@/auth/key-log-actions';
import { buildAdmitHubRecord } from '@/node/enrollment';
import { withKeyLogLock } from '@/node/enrollment-engine';
import { type HubApi, defaultHubApi } from '@/node/hub-api';
import { getMeshHubsState, refreshMeshHubs } from '@/node/mesh-hubs';
import type { NodeRow } from '@/node/mesh-nodes';
import { defaultApiClient } from '@tmex/api-client';
import type { AuthApi, HubAuthorizationKind, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import type { HubRoleErrorCode, HubRoleRequest, HubRoleTransitionPhase } from '@tmex/shared';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  type KeyLogHead,
  MIN_HUB_AUTH_RECORD_VERSION,
  encodeBase64url,
} from '@tmex/shared/auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { delay } from '../restart/wait-for-restart';
import type { ResolvedMode } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 轮询间隔：目标重启期间每一拍都是一次注定失败的请求，不必太密。 */
export const HUB_ROLE_POLL_MS = 2000;
/** 目标重启期间允许连续不可达多久；超出即判失败，不再空等。 */
export const HUB_ROLE_RESTART_BUDGET_MS = 90_000;
/** 等 `admit-hub` 在 `/api/mesh/hubs` 上生效的上限。 */
export const HUB_ROLE_AUTH_TIMEOUT_MS = 20_000;
/** 等 `writerHubId` 换成目标的上限；目标重启完成后这一步通常只要一两拍。 */
export const HUB_ROLE_WRITER_TIMEOUT_MS = 60_000;

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
  const code = err instanceof Error ? err.message : String(err);
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
    wait: async (ms, signal) => {
      await delay(ms, signal);
      return !signal.aborted;
    },
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

function hubRoleFailedText(t: Translate, code: string): string {
  return t('nodes.hubs.role.failed', { error: hubRoleErrorText(t, code) });
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

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export type HubRoleSwitchPhase =
  | 'admitting'
  | 'awaitingAuth'
  | 'demoting'
  | 'promoting'
  | 'restarting'
  | 'awaitingWriter';

/** 升主失败、且原主已经不在写时的恢复上下文：重试目标或回滚回原主都要这两个 id。 */
export interface HubRoleRecoverContext {
  targetHubId: string;
  fromHubId: string;
}

export type HubRoleRunOutcome =
  | { kind: 'done' }
  /** 请求都发出去了，但没能在预算内确认结果；不谎报成功，让用户自己刷新核对。 */
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }
  /** 原主已降备而目标没升起来：集群此刻没有 writer，必须让用户当场选下一步。 */
  | ({ kind: 'recover'; message: string } & HubRoleRecoverContext);

/** 走完签名 + 提交 + 必要时的强制重试；用户在任何一步取消都返回 `cancelled`。 */
export type AdmitHubStep = (target: HubRef) => Promise<AdmitHubOutcome | { kind: 'cancelled' }>;

/**
 * `admit-hub` 被旧节点挡住时的二次确认：列出老节点，勾了「仍然继续」才补强制头重发。
 * 强制过一次还挡着说明后端换了理由，不再无限重试。
 */
export async function admitHubWithForce(p: {
  submit: (force: boolean) => Promise<AdmitHubOutcome>;
  confirmForce: (info: { minVersion: string; nodes: UnsupportedKeyLogNode[] }) => Promise<boolean>;
}): Promise<AdmitHubOutcome | { kind: 'cancelled' }> {
  const first = await p.submit(false);
  if (first.kind !== 'unsupportedNodes') return first;
  const accepted = await p.confirmForce({ minVersion: first.minVersion, nodes: first.nodes });
  if (!accepted) return { kind: 'cancelled' };
  return p.submit(true);
}

export interface HubRoleTailParams {
  targetHubId: string;
  operationId: string;
  io: HubRoleIo;
  signal: AbortSignal;
  phase: (phase: HubRoleSwitchPhase) => void;
  t: Translate;
}

/**
 * 第 4 步（刷新后续跑的也是这一段）：轮询目标的 `roleStatus` 直到 `complete` / `failed`，
 * 期间的不可达按「重启中」计时；随后等入口的 `writerHubId` 换成目标。
 *
 * `HUB_ROLE_UNSUPPORTED` 在这里同样按「还没起来」重试：目标已经受理过这次切换，
 * 重启窗口里入口转发不到它时回的就是 404。预算耗尽才把它当成结论报出去。
 */
export async function awaitHubRoleSwitch(p: HubRoleTailParams): Promise<HubRoleRunOutcome> {
  p.phase('restarting');
  let downSince: number | null = null;
  let lastCode: string | null = null;
  while (true) {
    if (p.signal.aborted) return { kind: 'cancelled' };
    const status = await p.io.roleStatus(p.targetHubId, p.operationId);
    if (status.kind === 'ok') {
      downSince = null;
      if (status.phase === 'complete') break;
      if (status.phase === 'failed') {
        return {
          kind: 'failed',
          message: p.t('nodes.hubs.role.failed', {
            error: status.error
              ? hubRoleErrorText(p.t, status.error)
              : p.t('nodes.hubs.role.errors.unknown'),
          }),
        };
      }
    } else {
      if (status.kind === 'failed') lastCode = status.code;
      downSince ??= p.io.now();
      if (p.io.now() - downSince >= HUB_ROLE_RESTART_BUDGET_MS) {
        return {
          kind: 'unconfirmed',
          message: p.t('nodes.hubs.role.errors.restartTimeout', {
            error: lastCode
              ? hubRoleErrorText(p.t, lastCode)
              : p.t('nodes.hubs.role.errors.unreachable'),
          }),
        };
      }
    }
    if (!(await p.io.wait(HUB_ROLE_POLL_MS, p.signal))) return { kind: 'cancelled' };
  }

  p.phase('awaitingWriter');
  const deadline = p.io.now() + HUB_ROLE_WRITER_TIMEOUT_MS;
  while (true) {
    if (p.signal.aborted) return { kind: 'cancelled' };
    const snapshot = await p.io.hubs();
    if (snapshot.writerHubId === p.targetHubId) return { kind: 'done' };
    if (p.io.now() >= deadline) {
      return { kind: 'unconfirmed', message: p.t('nodes.hubs.role.errors.writerTimeout') };
    }
    if (!(await p.io.wait(HUB_ROLE_POLL_MS, p.signal))) return { kind: 'cancelled' };
  }
}

/** 每一个改动请求发出去之前先落一次续跑记录，参数就是记录里的 `phase`。 */
export type HubRolePersist = (phase: HubRoleResumePhase) => void;

interface HubRoleStepBase {
  io: HubRoleIo;
  signal: AbortSignal;
  phase: (phase: HubRoleSwitchPhase) => void;
  persist?: HubRolePersist;
  t: Translate;
  operationId: string;
}

/** 只降备、无人接管：没有第 3、4 步可走，POST 一落地就算完。 */
function demoteOnlyOutcome(t: Translate, outcome: HubRoleOutcome): HubRoleRunOutcome {
  if (outcome.kind === 'ok') return { kind: 'done' };
  if (outcome.kind === 'unreachable') {
    return { kind: 'unconfirmed', message: t('nodes.hubs.role.errors.unreachable') };
  }
  return { kind: 'failed', message: hubRoleFailedText(t, outcome.code) };
}

async function demoteOnly(p: HubRoleStepBase & { hubNodeId: string }): Promise<HubRoleRunOutcome> {
  p.persist?.('demote');
  p.phase('demoting');
  const outcome = await p.io.role(p.hubNodeId, { mode: 'standby', operationId: p.operationId });
  return demoteOnlyOutcome(p.t, outcome);
}

/**
 * 升主 + 跨重启的回读。请求**不带 writerEpoch**：目标自己取 `max(已知)+1`，前端的视野可能
 * 比它窄，硬塞一个纪元只会换来 `HUB_EPOCH_STALE`。真收到 stale 说明目标刚学到更高的纪元，
 * 原样重发一次让它重新取号；再失败就报出去。
 */
export async function promoteHub(
  p: HubRoleStepBase & { targetHubId: string; recover: HubRoleRecoverContext | null }
): Promise<HubRoleRunOutcome> {
  p.persist?.('promote');
  p.phase('promoting');
  const req: HubRoleRequest = { mode: 'active', operationId: p.operationId };
  let promoted = await p.io.role(p.targetHubId, req);
  if (promoted.kind === 'failed' && promoted.code === 'HUB_EPOCH_STALE') {
    promoted = await p.io.role(p.targetHubId, req);
  }
  if (promoted.kind === 'failed') {
    const message = hubRoleFailedText(p.t, promoted.code);
    return p.recover ? { kind: 'recover', message, ...p.recover } : { kind: 'failed', message };
  }
  // `unreachable`：202 的回包可能丢在目标的重启里，目标却已经受理——只能靠回读确认。
  p.persist?.('wait');
  const tail = await awaitHubRoleSwitch({
    targetHubId: p.targetHubId,
    operationId: p.operationId,
    io: p.io,
    signal: p.signal,
    phase: p.phase,
    t: p.t,
  });
  if (tail.kind === 'failed' && p.recover) {
    return { kind: 'recover', message: tail.message, ...p.recover };
  }
  return tail;
}

/** 降原主（必要时）+ 升目标。`demoted` 为真表示原主已经不在写了，续跑时会走到这一档。 */
async function switchWriter(
  p: HubRoleStepBase & {
    targetHubId: string;
    /** 原主；`null` = 没有原主，或原主不可达（跳过降备，靠更高纪元围栏它）。 */
    fromHubId: string | null;
    demoted: boolean;
  }
): Promise<HubRoleRunOutcome> {
  let writerLess = p.demoted;
  if (p.fromHubId && !p.demoted) {
    p.persist?.('demote');
    p.phase('demoting');
    const demoted = await p.io.role(p.fromHubId, { mode: 'standby', operationId: p.operationId });
    if (demoted.kind === 'failed') {
      return { kind: 'failed', message: hubRoleFailedText(p.t, demoted.code) };
    }
    // `unreachable` 也按「已经发出去」算：原主多半正在按这条指令重启。
    writerLess = true;
  }
  const from = p.fromHubId;
  return promoteHub({
    ...p,
    recover: from && writerLess ? { targetHubId: p.targetHubId, fromHubId: from } : null,
  });
}

export interface HubRoleRunParams {
  plan: HubRoleSwitchPlan;
  operationId: string;
  io: HubRoleIo;
  signal: AbortSignal;
  admit: AdmitHubStep;
  phase: (phase: HubRoleSwitchPhase) => void;
  /** 每一步开打之前落一次记录，刷新后据此续跑。 */
  persist?: HubRolePersist;
  t: Translate;
}

async function waitForSignedAuthorization(
  p: Pick<HubRoleRunParams, 'io' | 'signal' | 't'>,
  hubNodeId: string
): Promise<HubRoleRunOutcome | null> {
  const deadline = p.io.now() + HUB_ROLE_AUTH_TIMEOUT_MS;
  while (true) {
    if (p.signal.aborted) return { kind: 'cancelled' };
    const snapshot = await p.io.hubs();
    const hub = snapshot.hubs.find((row) => row.nodeId === hubNodeId);
    if (hub?.authorization === 'signed') return null;
    if (p.io.now() >= deadline) {
      return { kind: 'failed', message: p.t('nodes.hubs.role.errors.authTimeout') };
    }
    if (!(await p.io.wait(HUB_ROLE_POLL_MS, p.signal))) return { kind: 'cancelled' };
  }
}

export async function runHubRoleSwitch(p: HubRoleRunParams): Promise<HubRoleRunOutcome> {
  const target = p.plan.target;
  if (!target) return demoteOnly({ ...p, hubNodeId: p.plan.origin.nodeId });

  if (p.plan.needsAdmit) {
    p.persist?.('admit');
    p.phase('admitting');
    const admit = await p.admit(target);
    if (admit.kind === 'cancelled') return { kind: 'cancelled' };
    if (admit.kind === 'unsupportedNodes') {
      return {
        kind: 'failed',
        message: p.t('nodes.hubs.role.forceText', { minVersion: admit.minVersion }),
      };
    }
    if (admit.kind === 'failed') {
      return { kind: 'failed', message: hubRoleFailedText(p.t, admit.code) };
    }
    p.phase('awaitingAuth');
    const stalled = await waitForSignedAuthorization(p, target.nodeId);
    if (stalled) return stalled;
  }

  const from = p.plan.from;
  return switchWriter({
    ...p,
    targetHubId: target.nodeId,
    fromHubId:
      from && !p.plan.fromUnreachable && from.nodeId !== target.nodeId ? from.nodeId : null,
    demoted: false,
  });
}

// ---------------------------------------------------------------------------
// 断点续跑
// ---------------------------------------------------------------------------

/** 记录里的进度：每一档都对应「下一个要发的请求」，续跑时从这里接着走。 */
export type HubRoleResumePhase = 'admit' | 'demote' | 'promote' | 'wait';

export interface HubRoleSwitchRecord {
  operationId: string;
  /** 要升成主的那台；`demoteOnly` 时是被降的那台。 */
  targetHubId: string;
  /** 原主，用于续跑时判断降备是否已经落地、以及升主失败后回滚。 */
  fromHubId: string | null;
  /** `demoteOnly` 没有升主那一段，续跑时只重发一次幂等的 standby。 */
  intent: 'switch' | 'demoteOnly';
  phase: HubRoleResumePhase;
  startedAt: number;
}

const RESUME_PHASES: readonly HubRoleResumePhase[] = ['admit', 'demote', 'promote', 'wait'];

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // 隐私模式下取值本身就会抛：退化成「刷新即丢」，绝不让存储问题把切换带塌。
    return null;
  }
}

export function saveHubRoleSwitch(record: HubRoleSwitchRecord): void {
  try {
    sessionStore()?.setItem(HUB_ROLE_SWITCH_KEY, JSON.stringify(record));
  } catch {
    // 写不进去只影响续跑，本轮切换照常。
  }
}

export function clearHubRoleSwitch(): void {
  try {
    sessionStore()?.removeItem(HUB_ROLE_SWITCH_KEY);
  } catch {
    // 同上
  }
}

/** 每一步开打前都往同一条记录上更新 `phase`；其余字段整轮不变。 */
export function hubRoleSwitchPersist(base: Omit<HubRoleSwitchRecord, 'phase'>): HubRolePersist {
  return (phase) => saveHubRoleSwitch({ ...base, phase });
}

/** 存储里的东西一律当成不可信输入：字段缺一不可，过期的一律丢掉。 */
export function loadHubRoleSwitch(now: number): HubRoleSwitchRecord | null {
  let raw: string | null = null;
  try {
    raw = sessionStore()?.getItem(HUB_ROLE_SWITCH_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<HubRoleSwitchRecord>;
  if (typeof record.operationId !== 'string' || typeof record.targetHubId !== 'string') return null;
  if (typeof record.startedAt !== 'number') return null;
  if (now - record.startedAt > HUB_ROLE_SWITCH_TTL_MS) {
    clearHubRoleSwitch();
    return null;
  }
  return {
    operationId: record.operationId,
    targetHubId: record.targetHubId,
    fromHubId: typeof record.fromHubId === 'string' ? record.fromHubId : null,
    intent: record.intent === 'demoteOnly' ? 'demoteOnly' : 'switch',
    // 认不出的进度按最后一档处理：只回读，不重发任何改动请求。
    phase: RESUME_PHASES.includes(record.phase as HubRoleResumePhase)
      ? (record.phase as HubRoleResumePhase)
      : 'wait',
    startedAt: record.startedAt,
  };
}

export interface HubRoleResumeParams {
  record: HubRoleSwitchRecord;
  io: HubRoleIo;
  signal: AbortSignal;
  phase: (phase: HubRoleSwitchPhase) => void;
  persist?: HubRolePersist;
  t: Translate;
}

/**
 * 刷新后接着跑。四档进度都能接：
 * - `wait`：只回读第 4 步，什么都不重发。
 * - `admit`：授权已经签成才往下走；没签成就收摊——重签要用户凭据，不能刷新后替他按下去。
 * - `demote` / `promote`：看 `writerHubId`。原主还在写就重发降备（同一个 operationId，目标幂等），
 *   已经不在写就直接重发升主——这正是「降原主 → 升目标」之间那个集群没有 writer 的窗口。
 */
export async function resumeHubRoleSwitch(p: HubRoleResumeParams): Promise<HubRoleRunOutcome> {
  const record = p.record;
  const base: HubRoleStepBase = {
    io: p.io,
    signal: p.signal,
    phase: p.phase,
    persist: p.persist,
    t: p.t,
    operationId: record.operationId,
  };

  if (record.intent === 'demoteOnly') {
    return demoteOnly({ ...base, hubNodeId: record.targetHubId });
  }

  if (record.phase === 'wait') {
    const tail = await awaitHubRoleSwitch({
      targetHubId: record.targetHubId,
      operationId: record.operationId,
      io: p.io,
      signal: p.signal,
      phase: p.phase,
      t: p.t,
    });
    if (tail.kind === 'failed' && record.fromHubId) {
      return {
        kind: 'recover',
        message: tail.message,
        targetHubId: record.targetHubId,
        fromHubId: record.fromHubId,
      };
    }
    return tail;
  }

  const snapshot = await p.io.hubs();
  if (p.signal.aborted) return { kind: 'cancelled' };
  // 目标已经接管：刷新前那一段其实已经跑完了。
  if (snapshot.writerHubId === record.targetHubId) return { kind: 'done' };

  if (record.phase === 'admit') {
    const target = snapshot.hubs.find((hub) => hub.nodeId === record.targetHubId);
    if (target?.authorization !== 'signed') {
      return { kind: 'failed', message: p.t('nodes.hubs.role.errors.resumeAdmit') };
    }
  }

  return switchWriter({
    ...base,
    targetHubId: record.targetHubId,
    fromHubId: record.fromHubId,
    demoted: record.fromHubId !== null && snapshot.writerHubId !== record.fromHubId,
  });
}

// ---------------------------------------------------------------------------
// operationId
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

/**
 * 后端按 RFC-4122 正则校验 `operationId`，而非安全上下文（http:// 的局域网入口）没有
 * `crypto.randomUUID`：用随机字节手搓一个 v4，版本位与变体位都补上。
 */
export function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  let hex = '';
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 0x0f];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomOperationId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // 非安全上下文没有 randomUUID，退到手搓的 v4。
  }
  return randomUuidV4();
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface HubRoleForcePrompt {
  minVersion: string;
  nodes: UnsupportedKeyLogNode[];
}

/** 升主失败、集群暂时没有 writer 时摆在用户面前的两条出路。 */
export interface HubRoleRecoveryPrompt extends HubRoleRecoverContext {
  message: string;
  targetName: string;
  fromName: string;
}

export type HubRoleRecoveryChoice = 'retry' | 'rollback' | 'dismiss';

export interface HubRoleSwitchDeps {
  hubs: MeshHubEndpoint[];
  writerHubId: string | null;
  /** 名字取节点表那一份，确认框里写的与表里看到的是同一个名字。 */
  rows: NodeRow[];
  api: AuthApi;
  mode: ResolvedMode | null;
  prompt: CredentialPromptHandle;
  /** hub 当前接受管理写入；只影响需要签 `admit-hub` 的那一档。 */
  hubWritable: boolean;
}

export interface HubRoleSwitchController {
  /** 正在切换的 hub（目标 + 原主）：这些行显示「切换中」。 */
  switchingIds: ReadonlySet<string>;
  running: boolean;
  /** 待确认的计划；没有时为 `null`。 */
  plan: HubRoleSwitchPlan | null;
  /** 旧节点挡住 `admit-hub` 时的二次确认；没有时为 `null`。 */
  force: HubRoleForcePrompt | null;
  /** 升主失败后的恢复对话框；没有时为 `null`。 */
  recovery: HubRoleRecoveryPrompt | null;
  phase: HubRoleSwitchPhase | null;
  request: (row: NodeRow) => void;
  confirm: () => void;
  dismiss: () => void;
  resolveForce: (accepted: boolean) => void;
  resolveRecovery: (choice: HubRoleRecoveryChoice) => void;
  stateOf: (row: NodeRow, rowBusy: boolean) => HubRoleButtonState;
}

export interface UseHubRoleSwitchOptions {
  io?: HubRoleIo;
  now?: () => number;
}

export function useHubRoleSwitch(
  deps: HubRoleSwitchDeps,
  onChanged: () => void,
  options: UseHubRoleSwitchOptions = {}
): HubRoleSwitchController {
  const { t } = useTranslation();
  const io = useMemo(() => options.io ?? createHubRoleIo(), [options.io]);
  const now = options.now ?? Date.now;
  const [plan, setPlan] = useState<HubRoleSwitchPlan | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<HubRoleSwitchPhase | null>(null);
  const [switchingIds, setSwitchingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [force, setForce] = useState<HubRoleForcePrompt | null>(null);
  const [recovery, setRecovery] = useState<HubRoleRecoveryPrompt | null>(null);
  const forceResolve = useRef<((accepted: boolean) => void) | null>(null);
  const runRef = useRef<AbortController | null>(null);

  const nameOf = useCallback(
    (nodeId: string) => deps.rows.find((row) => row.id === nodeId)?.name ?? nodeId.slice(0, 8),
    [deps.rows]
  );

  // 续跑 effect 只在挂载时跑一次，因此它用到的东西一律走 ref：把它们放进依赖数组，
  // 节点列表每刷新一次就会重跑这个 effect，cleanup 顺手把还在轮询的续跑掐掉。
  const latest = useRef({ io, nameOf, now, onChanged, t });
  latest.current = { io, nameOf, now, onChanged, t };

  const settle = useCallback((outcome: HubRoleRunOutcome, targetName: string) => {
    const cur = latest.current;
    if (outcome.kind === 'recover') {
      // 集群此刻没有 writer：toast 会自己消失，这里必须留一个用户不点就不走的对话框。
      // 记录也留着，刷新后还能从 `promote` 那一档接着跑。
      setRecovery({
        message: outcome.message,
        targetHubId: outcome.targetHubId,
        targetName: cur.nameOf(outcome.targetHubId),
        fromHubId: outcome.fromHubId,
        fromName: cur.nameOf(outcome.fromHubId),
      });
      setPhase(null);
      return;
    }
    if (outcome.kind === 'done') {
      toast.success(cur.t('nodes.hubs.role.done', { target: targetName }));
    } else if (outcome.kind === 'unconfirmed') toast.warning(outcome.message);
    else if (outcome.kind === 'failed') toast.error(outcome.message);
    clearHubRoleSwitch();
    setSwitchingIds(new Set<string>());
    setRecovery(null);
    setPhase(null);
    setRunning(false);
    if (outcome.kind !== 'cancelled') cur.onChanged();
  }, []);

  /** 起一段切换：换掉上一段（若还在跑），并把「切换中」的行标出来。 */
  const drive = useCallback(
    (
      ids: Iterable<string>,
      targetName: string,
      task: (signal: AbortSignal) => Promise<HubRoleRunOutcome>
    ) => {
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      setRecovery(null);
      setRunning(true);
      setSwitchingIds(new Set(ids));
      void (async () => {
        const outcome = await task(controller.signal);
        if (controller.signal.aborted) return;
        settle(outcome, targetName);
      })();
    },
    [settle]
  );

  // 刷新页面时切换多半还卡在半路：按记录里的 phase 接着跑，不让用户对着一份「已完成」的假象。
  useEffect(() => {
    const cur = latest.current;
    const record = loadHubRoleSwitch(cur.now());
    if (record) {
      drive(
        record.fromHubId ? [record.targetHubId, record.fromHubId] : [record.targetHubId],
        cur.nameOf(record.targetHubId),
        (signal) =>
          resumeHubRoleSwitch({
            record,
            io: cur.io,
            signal,
            phase: setPhase,
            persist: hubRoleSwitchPersist(record),
            t: cur.t,
          })
      );
    }
    return () => runRef.current?.abort();
  }, [drive]);

  const request = useCallback(
    (row: NodeRow) => {
      const next = planHubRoleSwitch({
        row,
        hubs: deps.hubs,
        writerHubId: deps.writerHubId,
        nameOf,
      });
      if (next) setPlan(next);
    },
    [deps.hubs, deps.writerHubId, nameOf]
  );

  const dismiss = useCallback(() => setPlan(null), []);

  const resolveForce = useCallback((accepted: boolean) => {
    setForce(null);
    forceResolve.current?.(accepted);
    forceResolve.current = null;
  }, []);

  const { api, mode, prompt } = deps;
  const confirm = useCallback(() => {
    if (!plan || !mode) {
      setPlan(null);
      return;
    }
    const target = plan.target;
    const targetName = target?.name ?? plan.origin.name;
    const operationId = randomOperationId();
    const persist = hubRoleSwitchPersist({
      operationId,
      targetHubId: target?.nodeId ?? plan.origin.nodeId,
      fromHubId: plan.from?.nodeId ?? null,
      intent: target ? 'switch' : 'demoteOnly',
      startedAt: now(),
    });
    setPlan(null);
    toast.info(t('nodes.hubs.role.started'));
    drive(
      [
        plan.origin.nodeId,
        ...(target ? [target.nodeId] : []),
        ...(plan.from ? [plan.from.nodeId] : []),
      ],
      targetName,
      (signal) =>
        runHubRoleSwitch({
          plan,
          operationId,
          io,
          signal,
          phase: setPhase,
          persist,
          t,
          admit: (hub) =>
            admitHubSigned({ api, mode, prompt, io, target: hub, setForce, forceResolve }),
        })
    );
  }, [api, drive, io, mode, now, plan, prompt, t]);

  const resolveRecovery = useCallback(
    (choice: HubRoleRecoveryChoice) => {
      const current = recovery;
      if (!current || choice === 'dismiss') {
        runRef.current?.abort();
        clearHubRoleSwitch();
        setRecovery(null);
        setSwitchingIds(new Set<string>());
        setPhase(null);
        setRunning(false);
        return;
      }
      const rollback = choice === 'rollback';
      const targetHubId = rollback ? current.fromHubId : current.targetHubId;
      // 重试与回滚都要一个新的 operationId：目标按 operationId 幂等，沿用旧的只会把那条
      // 失败记录原样还回来。回滚成功与否都保留同一套恢复上下文，用户可以来回换。
      const operationId = randomOperationId();
      const persist = hubRoleSwitchPersist({
        operationId,
        targetHubId,
        fromHubId: null,
        intent: 'switch',
        startedAt: now(),
      });
      drive(
        [current.targetHubId, current.fromHubId],
        rollback ? current.fromName : current.targetName,
        (signal) =>
          promoteHub({
            io,
            signal,
            phase: setPhase,
            persist,
            t,
            operationId,
            targetHubId,
            recover: { targetHubId: current.targetHubId, fromHubId: current.fromHubId },
          })
      );
    },
    [drive, io, now, recovery, t]
  );

  const stateOf = useCallback(
    (row: NodeRow, rowBusy: boolean) =>
      hubRoleButtonState({
        row,
        hubs: deps.hubs,
        writerHubId: deps.writerHubId,
        hubWritable: deps.hubWritable,
        switching: running,
        rowBusy,
        nameOf,
      }),
    [deps.hubWritable, deps.hubs, deps.writerHubId, nameOf, running]
  );

  return useMemo(
    () => ({
      switchingIds,
      running,
      plan,
      force,
      recovery,
      phase,
      request,
      confirm,
      dismiss,
      resolveForce,
      resolveRecovery,
      stateOf,
    }),
    [
      confirm,
      dismiss,
      force,
      phase,
      plan,
      recovery,
      request,
      resolveForce,
      resolveRecovery,
      running,
      stateOf,
      switchingIds,
    ]
  );
}

/**
 * 签一条 `admit-hub` 并提交。`head → 签名 → append` 整段进 key log 写锁：head 是全局的，
 * 与一条 admit-node 并行读到同一个头就会造出两条同 seq 的记录（见 `revokeNodeRecord`）。
 * 等用户勾「仍然继续」的对话框留在锁外，否则一发呆就把所有 admit 卡住。
 */
async function admitHubSigned(p: {
  api: AuthApi;
  mode: ResolvedMode;
  prompt: CredentialPromptHandle;
  io: HubRoleIo;
  target: HubRef;
  setForce: (prompt: HubRoleForcePrompt | null) => void;
  forceResolve: { current: ((accepted: boolean) => void) | null };
}): Promise<AdmitHubOutcome | { kind: 'cancelled' }> {
  const rootEpoch = requireRootEpoch(p.mode);
  const submit = async (signer: RecordSigner, force: boolean): Promise<AdmitHubOutcome> =>
    withKeyLogLock(async () => {
      const head: KeyLogHead = headFromResponse(await p.api.keyLogHead());
      const record = await buildAdmitHubRecord({
        head,
        rootEpoch,
        uid: p.mode.uid,
        hubNodeIdHex: p.target.nodeId,
        publicUrl: p.target.publicUrl,
        signer,
      });
      return p.io.appendAdmitHub(record, force);
    });

  const outcome = await p.prompt.withSigner(
    (signer) =>
      admitHubWithForce({
        submit: (force) => submit(signer, force),
        confirmForce: (info) =>
          new Promise<boolean>((resolve) => {
            p.forceResolve.current = resolve;
            p.setForce(info);
          }),
      }),
    { purpose: 'admit' }
  );
  return outcome ?? { kind: 'cancelled' };
}
