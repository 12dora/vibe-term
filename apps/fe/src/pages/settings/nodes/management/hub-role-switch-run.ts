// Hub 主备切换的状态机与断点续跑：只依赖 `HubRoleIo` 这一层接缝，不碰 React 与网络实现。

import type { HubRoleRequest } from '@tmex/shared';
import {
  type AdmitHubOutcome,
  HUB_ROLE_AUTH_TIMEOUT_MS,
  HUB_ROLE_HUBS_TIMEOUT_MS,
  HUB_ROLE_POLL_MS,
  HUB_ROLE_RESTART_BUDGET_MS,
  HUB_ROLE_SWITCH_KEY,
  HUB_ROLE_SWITCH_TTL_MS,
  HUB_ROLE_WRITER_TIMEOUT_MS,
  type HubRef,
  type HubRoleIo,
  type HubRoleOutcome,
  type HubRoleSwitchPlan,
  type HubsSnapshot,
  type Translate,
  type UnsupportedKeyLogNode,
  hubRoleErrorText,
  hubRoleFailedText,
  hubRoleLocalFailedText,
} from './hub-role-switch-model';

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

/** 一段切换拿到的接缝：`onRecoverContext` 在进入「原主已降备」的窗口时被调用。 */
export interface HubRoleRunContext {
  signal: AbortSignal;
  onRecoverContext: (context: HubRoleRecoverContext) => void;
}

/**
 * 兜住整段切换：网络异常、依赖抛错都不能变成未处理的 rejection，更不能把页面永远留在
 * `running=true`。已经进入没有 writer 的窗口时（`recover()` 有值）同样进恢复框，不是一条 toast。
 */
export async function guardHubRoleRun(p: {
  run: () => Promise<HubRoleRunOutcome>;
  recover: () => HubRoleRecoverContext | null;
  t: Translate;
}): Promise<HubRoleRunOutcome> {
  try {
    return await p.run();
  } catch {
    const message = hubRoleLocalFailedText(p.t, 'unexpected');
    const context = p.recover();
    return context ? { kind: 'recover', message, ...context } : { kind: 'failed', message };
  }
}

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
 * 读一次 `/api/mesh/hubs`。切换途中入口本身也可能短暂不可达，抛出来的异常不是结论：
 * 一律当成「这一拍没读到」，何时收手交给各自的预算，绝不让它变成未处理的 rejection。
 */
async function readHubs(io: HubRoleIo): Promise<HubsSnapshot | null> {
  try {
    return await io.hubs();
  } catch {
    return null;
  }
}

/** 只读一次不够的地方（续跑要先看 `writerHubId` 才知道从哪一档接着跑）：在预算内重试。 */
async function readHubsWithin(p: {
  io: HubRoleIo;
  signal: AbortSignal;
}): Promise<HubsSnapshot | null> {
  const deadline = p.io.now() + HUB_ROLE_HUBS_TIMEOUT_MS;
  while (true) {
    const snapshot = await readHubs(p.io);
    if (snapshot) return snapshot;
    if (p.signal.aborted || p.io.now() >= deadline) return null;
    if (!(await p.io.wait(HUB_ROLE_POLL_MS, p.signal))) return null;
  }
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
    const snapshot = await readHubs(p.io);
    if (snapshot?.writerHubId === p.targetHubId) return { kind: 'done' };
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
  /** 一进入「原主已降备」的窗口就交回恢复上下文：之后即便抛异常也知道该弹恢复框。 */
  onRecoverContext?: (context: HubRoleRecoverContext) => void;
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
  if (p.recover) p.onRecoverContext?.(p.recover);
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
  // `unconfirmed` 在这里与 `failed` 同等对待：原主已经降备，而目标既没确认受理也没接管写入，
  // 集群此刻很可能一个 writer 都没有——一条会自己消失的 toast 顶不住，必须让用户当场选。
  if ((tail.kind === 'failed' || tail.kind === 'unconfirmed') && p.recover) {
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
  onRecoverContext?: (context: HubRoleRecoverContext) => void;
}

async function waitForSignedAuthorization(
  p: Pick<HubRoleRunParams, 'io' | 'signal' | 't'>,
  hubNodeId: string
): Promise<HubRoleRunOutcome | null> {
  const deadline = p.io.now() + HUB_ROLE_AUTH_TIMEOUT_MS;
  while (true) {
    if (p.signal.aborted) return { kind: 'cancelled' };
    const snapshot = await readHubs(p.io);
    const hub = snapshot?.hubs.find((row) => row.nodeId === hubNodeId);
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
  onRecoverContext?: (context: HubRoleRecoverContext) => void;
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
    onRecoverContext: p.onRecoverContext,
  };
  const recover: HubRoleRecoverContext | null = record.fromHubId
    ? { targetHubId: record.targetHubId, fromHubId: record.fromHubId }
    : null;

  if (record.intent === 'demoteOnly') {
    return demoteOnly({ ...base, hubNodeId: record.targetHubId });
  }

  if (record.phase === 'wait') {
    // 刷新前升主已经发出去了：原主多半已降备，这一段的失败与超时都得进恢复框。
    if (recover) p.onRecoverContext?.(recover);
    const tail = await awaitHubRoleSwitch({
      targetHubId: record.targetHubId,
      operationId: record.operationId,
      io: p.io,
      signal: p.signal,
      phase: p.phase,
      t: p.t,
    });
    if ((tail.kind === 'failed' || tail.kind === 'unconfirmed') && recover) {
      return { kind: 'recover', message: tail.message, ...recover };
    }
    return tail;
  }

  const snapshot = await readHubsWithin({ io: p.io, signal: p.signal });
  if (p.signal.aborted) return { kind: 'cancelled' };
  if (!snapshot) {
    // 读不到 hub 集合就不知道降备落没落地，更不能盲发一条升主：交给用户在恢复框里选。
    const message = hubRoleLocalFailedText(p.t, 'hubsUnreachable');
    return recover ? { kind: 'recover', message, ...recover } : { kind: 'unconfirmed', message };
  }
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
