// enrollment 的宿主级唯一引擎：**一条**证书监听回路 + **一条** admit 流水线。
//
// 为什么必须是单例：`admit-node` 是签在本地 key log 头上的记录。若两个 UI（设置页的节点管理
// 与「接入更多设备」侧滑面板）各自跑一套监听 + admit，同一张证书会被两处同时签出两条 seq
// 相邻的记录，hub 只收得下其中一条，另一条永远 `seq_gap`——这是不可恢复的分叉
// （见 `enrollment.ts` 的 `admitPlan` 与 `key-log-actions.ts`）。
//
// 因此：
//   - 监听回路（`/mesh/ws` 推送 + 5s 轮询）按注册数引用计数，只跑一份；
//   - admit 按 `hubEnrollmentId` 上模块级互斥锁，一个 outcome 最多签一次；
//   - 同一时刻只有**一个**生效上下文（最后注册的那个），注销后回落到上一个。

import { takeRememberedSigner } from '@/auth/credential-prompt';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  type CertificateCandidate,
  type PendingEnrollment,
  type SignedRecord,
  admitPlan,
  buildAdmitNodeRecord,
  forgetUnconfirmedRecord,
  isPendingExpired,
  listPendingEnrollments,
  listUnconfirmedRecordIds,
  nextPendingExpiry,
  prunePendingEnrollments,
  removePendingEnrollment,
  submitAdmitRecord,
  subscribePendingEnrollments,
  subscribeUnconfirmedRecords,
  unconfirmedRecord,
} from './enrollment';
import {
  type CertificateOutcome,
  ENROLLMENT_POLL_INTERVAL_MS,
  collectRedeemedCertificates,
  offerCertificate,
  outcomesForCandidates,
} from './enrollment-watch';
import type { HubApi } from './hub-api';
import { type MeshEventSource, sharedMeshEvents } from './mesh-events';

/**
 * 证书一到就自动签 `admit-node`——只有根钥签名者可以这么干。
 *
 * passkey 每签一次都要一次认证器仪式，而仪式必须由用户手势触发（Safari 强制要求，
 * Chrome 也会因为缺少 user activation 拒掉）。后台自动发起注定失败，不如留在「待确认」：
 * 用户点按钮时复用窗口里的凭证还在，不必再选一次 passkey。
 */
export function canAutoSignAdmit(signer: RecordSigner | null): boolean {
  return signer?.kind === 'root';
}

/** 证书对不上时的提示：过期与验签失败要分开讲，其余情况一律按验签失败处理。 */
export function invalidCertificateKey(reason: string): string {
  return reason === 'expired' ? 'nodes.enrollment.expired' : 'nodes.enrollment.badCertSig';
}

/** 签 admit 记录所需的用户身份；`ResolvedMode` 天然满足。 */
export interface AdmitMode extends Pick<AuthModeResponse, 'rootEpoch'> {
  uid: string;
}

export interface AdmitContext {
  api: AuthApi;
  /** 缺 uid / kdf 参数（还没有主用户）时为 `null`：引擎不签任何东西。 */
  mode: AdmitMode | null;
  hubApi: HubApi | null;
  prompt: CredentialPromptHandle;
  /** admit 成功后刷新列表。 */
  onDone: () => void;
  /** 消费方的翻译函数：引擎在模块级，拿不到 React 的 i18n 上下文。 */
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface EnrollmentEngineState {
  /** 正在跑 admit 的 pending id。 */
  busyPendingId: string | null;
  /** 已 admit 成功的 pending id。 */
  admittedIds: string[];
  /** 过期被清掉的 pending id。 */
  expiredIds: string[];
  /** 用户主动取消的 pending id。 */
  cancelledIds: string[];
  /** 上面三者的并集：对应的 join 串必须立刻从 DOM 里消失。引用稳定。 */
  clearedIds: string[];
  /** hub 未确认、手上还留着一份可重发记录的 pending id。 */
  hubUnconfirmedIds: string[];
  /** 已收到**有效**证书、等待签 admit 的 pending id（passkey 用户要手动点确认）。 */
  certificateReadyIds: string[];
  /** 证书判定失败的 pending id → 提示用的 i18n key。 */
  invalidById: Record<string, string>;
}

const EMPTY_STATE: EnrollmentEngineState = {
  busyPendingId: null,
  admittedIds: [],
  expiredIds: [],
  cancelledIds: [],
  clearedIds: [],
  hubUnconfirmedIds: [],
  certificateReadyIds: [],
  invalidById: {},
};

let state: EnrollmentEngineState = EMPTY_STATE;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function commit(patch: Partial<EnrollmentEngineState>): void {
  const next = { ...state, ...patch };
  if (patch.admittedIds || patch.expiredIds || patch.cancelledIds) {
    next.clearedIds = [...next.admittedIds, ...next.expiredIds, ...next.cancelledIds];
  }
  state = next;
  notify();
}

function appendId(list: string[], id: string): string[] | null {
  return list.includes(id) ? null : [...list, id];
}

export function getEnrollmentEngineState(): EnrollmentEngineState {
  return state;
}

export function subscribeEnrollmentEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// hub 未确认集合是 `enrollment.ts` 的模块级 store，直接镜像进来，消费方只订阅一处。
subscribeUnconfirmedRecords(() => commit({ hubUnconfirmedIds: listUnconfirmedRecordIds() }));

// ---------------------------------------------------------------------------
// 生效上下文
// ---------------------------------------------------------------------------

interface ContextSlot {
  value: AdmitContext | null;
}

const slots: ContextSlot[] = [];

/** 最后注册且仍有值的上下文；注销后自然回落到上一个。 */
function activeContext(): AdmitContext | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].value) return slots[i].value;
  }
  return null;
}

/**
 * 轮询用的 hub 通道单独取最近一个**非空**的：生效上下文可能还没定位到 hub
 * （侧滑面板只认 `/api/auth/mode` 的 `hubNodeId`，设置页还会认 mesh 列表的 `isHub`），
 * 直接跟着生效上下文走会让轮询在面板打开期间失效。
 */
function activeHubApi(): HubApi | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const hubApi = slots[i].value?.hubApi;
    if (hubApi) return hubApi;
  }
  return null;
}

function attachSlot(slot: ContextSlot): () => void {
  slots.push(slot);
  if (slots.length === 1 && !unsubscribePendings) {
    unsubscribePendings = subscribePendingEnrollments(onPendingsChanged);
  }
  onPendingsChanged();
  return () => {
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    if (slots.length === 0) {
      unsubscribePendings?.();
      unsubscribePendings = null;
    }
    onPendingsChanged();
  };
}

/** 注册一个 admit 上下文，返回注销函数。React 之外（测试）也能用。 */
export function registerAdmitContext(context: AdmitContext): () => void {
  return attachSlot({ value: context });
}

// ---------------------------------------------------------------------------
// 监听回路
// ---------------------------------------------------------------------------

interface EngineOverrides {
  events?: MeshEventSource;
  collect?: (pendings: PendingEnrollment[]) => Promise<CertificateCandidate[]>;
  intervalMs?: number;
  now?: () => number;
}

let overrides: EngineOverrides = {};
let unsubscribePendings: (() => void) | null = null;
let unsubscribePush: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;
let ticking = false;

function nowMs(): number {
  return (overrides.now ?? Date.now)();
}

function onPendingsChanged(): void {
  scheduleSweep();
  syncWatch();
}

/**
 * 过期清理必须是**定时**的：面板一直开着时，十分钟前建的 pending 不能继续留在内存与
 * sessionStorage 里，对应的 join 串也不能继续留在 DOM（见 F4-3 评审 Major）。
 */
function scheduleSweep(): void {
  // prune 会回调 pending store 的订阅者，重入直接返回，最终排期由最外层那次决定。
  if (sweeping) return;
  sweeping = true;
  try {
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
    if (slots.length === 0) return;
    const removed = prunePendingEnrollments(nowMs());
    if (removed.length > 0) {
      let expired = state.expiredIds;
      for (const row of removed) expired = appendId(expired, row.hubEnrollmentId) ?? expired;
      if (expired !== state.expiredIds) commit({ expiredIds: expired });
    }
    const next = nextPendingExpiry(listPendingEnrollments());
    if (next === null) return;
    sweepTimer = setTimeout(
      () => {
        sweepTimer = null;
        scheduleSweep();
      },
      Math.max(0, next - nowMs()) + 1
    );
  } finally {
    sweeping = false;
  }
}

function syncWatch(): void {
  const wanted = slots.length > 0 && listPendingEnrollments().length > 0;
  if (wanted === (pollTimer !== null)) return;
  if (wanted) startWatch();
  else stopWatch();
}

function startWatch(): void {
  const source = overrides.events ?? sharedMeshEvents();
  source.start();
  // 推送：hub → entry → `/mesh/ws`。与轮询汇进同一个 `handleOutcome`。
  unsubscribePush = source.onEnrollRedeemed((event) => {
    void handleOutcome(
      offerCertificate(
        listPendingEnrollments(),
        { certificate: event.certificate, certSig: event.certSig },
        nowMs()
      )
    );
  });
  pollTimer = setInterval(() => void tick(), overrides.intervalMs ?? ENROLLMENT_POLL_INTERVAL_MS);
  void tick();
}

function stopWatch(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  unsubscribePush?.();
  unsubscribePush = null;
}

/**
 * 轮询兜底：逐条 pending 查 `GET /n/<hub>/api/hub/enrollments/:id`。
 * 查的是本次 enrollment 的 id，因此 `unknown` 是真正的异常信号，照常上报。
 */
async function tick(): Promise<void> {
  if (ticking) return;
  const pendings = listPendingEnrollments();
  if (pendings.length === 0) return;
  const hubApi = activeHubApi();
  ticking = true;
  let candidates: CertificateCandidate[] = [];
  try {
    if (overrides.collect) candidates = await overrides.collect(pendings);
    else if (hubApi) candidates = await collectRedeemedCertificates(hubApi, pendings);
  } catch {
    return;
  } finally {
    ticking = false;
  }
  // 串行处理：并行签名等于给同一个 head 造两条记录。
  for (const outcome of outcomesForCandidates(pendings, candidates, nowMs())) {
    await handleOutcome(outcome);
  }
}

// ---------------------------------------------------------------------------
// admit 流水线
// ---------------------------------------------------------------------------

/** 模块级互斥：同一条 pending 同时只允许一次 admit 在飞。 */
const inFlight = new Set<string>();

async function withBusy(id: string, run: () => Promise<void>): Promise<void> {
  inFlight.add(id);
  commit({ busyPendingId: id });
  try {
    await run();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight.delete(id);
    if (state.busyPendingId === id) commit({ busyPendingId: null });
  }
}

/** 把一条**已签好**的 admit 记录送出去，并按 B2-6 的码处理结果。 */
async function submitAdmit(
  context: AdmitContext,
  pending: PendingEnrollment,
  record: SignedRecord
): Promise<void> {
  const id = pending.hubEnrollmentId;
  // hub=sync：entry 先把记录送 hub 并等 ack，确认之前本地什么都不写。
  const disposition = await submitAdmitRecord(context.api, id, record);
  if (disposition.kind === 'unconfirmed') {
    // hub 没确认就删 pending 会把 enroll 授权丢掉，而新 node 永远成不了 mesh 成员。
    toast.warning(context.t('nodes.enrollment.hubNotConfirmed'));
    return;
  }
  if (disposition.kind === 'stale') {
    // fork / seq_gap：这份字节永远不会被接受，让用户重新签一条。
    toast.error(context.t('nodes.enrollment.staleRecord'));
    return;
  }
  if (disposition.kind === 'error') {
    toast.error(context.t(`auth.errors.${disposition.code}`, { defaultValue: disposition.code }));
    return;
  }
  removePendingEnrollment(id);
  commit({ admittedIds: appendId(state.admittedIds, id) ?? state.admittedIds });
  toast.success(context.t('nodes.enrollment.admitted'));
  context.onDone();
}

async function signAdmit(
  context: AdmitContext,
  pending: PendingEnrollment,
  certificateBytes: Uint8Array,
  certSig: Uint8Array,
  signer: RecordSigner
): Promise<void> {
  const { mode } = context;
  if (!mode) return;
  const head = headFromResponse(await context.api.keyLogHead());
  // 取 head 是异步的：这中间 pending 可能已经过期，过期后签出来的 admit 也不该被接受。
  if (isPendingExpired(pending, nowMs())) {
    toast.error(context.t('nodes.enrollment.expired'));
    forgetUnconfirmedRecord(pending.hubEnrollmentId);
    removePendingEnrollment(pending.hubEnrollmentId);
    commit({
      expiredIds: appendId(state.expiredIds, pending.hubEnrollmentId) ?? state.expiredIds,
    });
    return;
  }
  const record = await buildAdmitNodeRecord({
    head,
    rootEpoch: requireRootEpoch(mode),
    uid: mode.uid,
    pending,
    certificateBytes,
    certSig,
    signer,
  });
  await submitAdmit(context, pending, {
    bytes: encodeBase64url(record.bytes),
    sig: encodeBase64url(record.sig),
  });
}

/** 轮询 / 推送检测出的结果。已过期或签名坏的直接告警；能自动签就自动签。 */
async function handleOutcome(outcome: CertificateOutcome): Promise<void> {
  const context = activeContext();
  if (!context) return;
  if (outcome.kind === 'unknown') {
    toast.error(context.t('nodes.enrollment.unknownCertificate'));
    return;
  }
  if (outcome.kind === 'invalid') {
    const key = invalidCertificateKey(outcome.reason);
    const id = outcome.pending.hubEnrollmentId;
    if (state.invalidById[id] !== key) {
      commit({ invalidById: { ...state.invalidById, [id]: key } });
      toast.error(context.t(key));
    }
    return;
  }
  const id = outcome.pending.hubEnrollmentId;
  // 锁在取签名者之前：重复的 outcome 不该白白消耗复用窗口里的凭证。
  if (inFlight.has(id)) return;
  commit({
    certificateReadyIds: appendId(state.certificateReadyIds, id) ?? state.certificateReadyIds,
  });
  const signer = takeRememberedSigner(nowMs());
  // 复用窗口已过、或窗口里是 passkey：都留在「待确认」，等用户点按钮。
  const plan = admitPlan(id, canAutoSignAdmit(signer));
  if (plan === 'wait') return;
  await withBusy(id, async () => {
    const stored = unconfirmedRecord(id);
    if (plan === 'resend' && stored) await submitAdmit(context, outcome.pending, stored);
    else if (signer) {
      await signAdmit(context, outcome.pending, outcome.certificateBytes, outcome.certSig, signer);
    }
  });
}

/**
 * 「待确认 / 重试」按钮。
 *
 * 该 pending 手上还留着一条 hub 未确认的记录时，**只重发这份字节**：不要凭据、不取新 head、
 * 不重新签名。B2-6 保证未确认时服务端没落库，本地 head 没动，原记录仍然接得上；
 * 而重签会按（可能已推进的）本地 head 产生新 seq，一旦 hub 缺中间那条就永久拒绝。
 */
export async function confirmManually(pending: PendingEnrollment): Promise<void> {
  const context = activeContext();
  if (!context?.mode) return;
  const id = pending.hubEnrollmentId;
  if (inFlight.has(id)) return;
  const stored = unconfirmedRecord(id);
  if (stored) {
    await withBusy(id, () => submitAdmit(context, pending, stored));
    return;
  }
  let signer: RecordSigner | null;
  try {
    // request() 会把签名者放进 5 分钟复用窗口，后续自动 admit 直接用它。
    signer = await context.prompt.request({ purpose: 'admit', reuse: true });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!signer) return;
  await withBusy(id, async () => {
    const hubApi = activeHubApi();
    const candidates = hubApi ? await collectRedeemedCertificates(hubApi, [pending]) : [];
    for (const candidate of candidates) {
      const outcome = offerCertificate([pending], candidate, nowMs());
      if (outcome.kind === 'admit') {
        await signAdmit(context, pending, outcome.certificateBytes, outcome.certSig, signer);
        return;
      }
      if (outcome.kind === 'invalid') {
        toast.error(context.t(invalidCertificateKey(outcome.reason)));
        return;
      }
    }
    toast.error(context.t('nodes.enrollment.noCertificateYet'));
  });
}

/** 取消只删本地 pending（hub 侧记录会自然过期），同时让对应的 join 串立刻消失。 */
export function cancelPending(pending: { hubEnrollmentId: string }): void {
  removePendingEnrollment(pending.hubEnrollmentId);
  commit({
    cancelledIds: appendId(state.cancelledIds, pending.hubEnrollmentId) ?? state.cancelledIds,
  });
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

/**
 * 注册一个 admit 上下文并在挂载期间维持监听回路。
 *
 * 每次渲染都把最新的 `hubApi` / `prompt` / `t` 写进同一个槽位，回路因此总用最新依赖，
 * 而槽位身份不变——注销时准确回落到上一个消费方。
 */
export function useEnrollmentEngine(context: AdmitContext): void {
  const slot = useRef<ContextSlot>({ value: null });
  slot.current.value = context;
  useEffect(() => {
    const current = slot.current;
    return attachSlot(current);
  }, []);
}

export function useEnrollmentEngineState(): EnrollmentEngineState {
  return useSyncExternalStore(
    subscribeEnrollmentEngine,
    getEnrollmentEngineState,
    getEnrollmentEngineState
  );
}

// ---------------------------------------------------------------------------
// 测试钩子
// ---------------------------------------------------------------------------

export function configureEnrollmentEngineForTest(next: EngineOverrides): void {
  overrides = { ...overrides, ...next };
}

export function setEnrollmentEngineStateForTest(patch: Partial<EnrollmentEngineState>): void {
  commit(patch);
}

export function enrollmentEngineDebugForTest(): {
  contexts: number;
  watching: boolean;
  sweeping: boolean;
} {
  return { contexts: slots.length, watching: pollTimer !== null, sweeping: sweepTimer !== null };
}

export function resetEnrollmentEngineForTest(): void {
  stopWatch();
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  unsubscribePendings?.();
  unsubscribePendings = null;
  slots.length = 0;
  inFlight.clear();
  ticking = false;
  overrides = {};
  state = EMPTY_STATE;
  notify();
}
