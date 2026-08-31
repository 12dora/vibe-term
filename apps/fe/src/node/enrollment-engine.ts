// enrollment 的宿主级唯一引擎：**一条**证书监听回路 + **一条** admit 流水线。
//
// 为什么必须是单例：`admit-node` 是签在本地 key log 头上的记录。若两个 UI（设置页的节点管理
// 与「接入更多设备」侧滑面板）各自跑一套监听 + admit，同一张证书会被两处同时签出两条 seq
// 相邻的记录，hub 只收得下其中一条，另一条永远 `seq_gap`——这是不可恢复的分叉
// （见 `enrollment.ts` 的 `admitPlan` 与 `key-log-actions.ts`）。
//
// 因此：
//   - 监听回路（`/mesh/ws` 推送 + 5s 轮询）按注册数引用计数，只跑一份；
//   - `keyLogHead → 构造签名 → append` 整段走**引擎级**的一条 FIFO 写锁（key log 的头是全局的，
//     按 enrollment 上锁挡不住两条不同 enrollment 并行读到同一个头）；
//   - 每次 await 之后都按权威 pending store 复核，陈旧结果一律静默丢弃；
//   - 手动确认绑定发起它的那个消费方槽位，后台自动签则挑一个凭据齐备的槽位。

import { forgetSigner, leaseSigner, takeRememberedSigner } from '@/auth/credential-prompt';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  type CertificateCandidate,
  type PendingEnrollment,
  type SignedRecord,
  admitPlan,
  buildAdmitNodeRecord,
  clearPendingEnrollments,
  clearUnconfirmedRecords,
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
  /** 缺 uid / kdf 参数（还没有主用户）时为 `null`：这个消费方不参与签名。 */
  mode: AdmitMode | null;
  hubApi: HubApi | null;
  prompt: CredentialPromptHandle;
  /** admit 成功后刷新列表。 */
  onDone: () => void;
  /** 消费方的翻译函数：引擎在模块级，拿不到 React 的 i18n 上下文。 */
  t: (key: string, options?: Record<string, unknown>) => string;
}

/** 绑定到某个消费方槽位的动作。 */
export interface EnrollmentEngineHandle {
  /** 「待确认 / 重试」按钮：只认 enrollment id，pending 一律从权威 store 现取。 */
  confirmManually(enrollmentId: string): Promise<void>;
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

/** 一个订阅者抛异常不能把后面的订阅者和调用方一起带走（调用方常在 `finally` 之前）。 */
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 订阅者自己的渲染错误由 React 的错误边界处理，引擎只保证状态一致。
    }
  }
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

/** 最后注册且仍有值的上下文；只用来出提示文案。 */
function activeContext(): AdmitContext | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].value) return slots[i].value;
  }
  return null;
}

/**
 * 后台自动签用的上下文：最近一个**凭据齐备**（`mode` 非空）的槽位。
 *
 * 侧滑面板可能先于 `/api/auth/mode` 返回就注册进来，此时它的 `mode` 还是 `null`；
 * 跟着「最后注册的槽位」走会让设置页那个可用上下文被一个空壳挡住（见 R4 #4）。
 */
function signingContext(): AdmitContext | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].value?.mode) return slots[i].value;
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

/** admit 成功后，**每个**还活着的消费方都要刷新自己的列表，而不只是签名的那个。 */
function fanOutDone(): void {
  for (const slot of [...slots]) {
    try {
      slot.value?.onDone();
    } catch {
      // 一个消费方的刷新失败不该拖住其它消费方。
    }
  }
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

/** 注册一个 admit 上下文；`release()` 注销。React 之外（测试）也能用。 */
export function registerAdmitContext(
  context: AdmitContext
): EnrollmentEngineHandle & { release: () => void } {
  const slot: ContextSlot = { value: context };
  const detach = attachSlot(slot);
  return {
    confirmManually: (enrollmentId: string) => confirmFromSlot(slot, enrollmentId),
    release: detach,
  };
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

/** 权威 pending：id 与 `enrollPk` 都对得上才算同一条（id 复用也骗不过去）。 */
function livePending(id: string, enrollPk?: string): PendingEnrollment | null {
  const row = listPendingEnrollments().find((item) => item.hubEnrollmentId === id);
  if (!row) return null;
  return enrollPk === undefined || row.enrollPk === enrollPk ? row : null;
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
    for (const row of prunePendingEnrollments(nowMs())) {
      finishPending(row.hubEnrollmentId, 'expired');
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
 *
 * 结果按**拉取时**的 pending 快照判定（这样才知道证书属于谁），随后由 `handleOutcome`
 * 对权威 store 复核：期间已被推送 admit / 被取消的那条，静默丢弃（见 R4 #2）。
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
// 终态清理
// ---------------------------------------------------------------------------

/**
 * admit / 过期 / 取消走**同一条**收尾：丢掉可重发记录、删本地 pending、清掉这条 id 的
 * 所有投影（证书已到 / 判定失败）。少清一样，下一条同 id 的记录就会带着上一轮的残留状态。
 */
function finishPending(id: string, outcome: 'admitted' | 'expired' | 'cancelled'): void {
  forgetUnconfirmedRecord(id);
  if (livePending(id)) removePendingEnrollment(id);
  commit({ ...clearProjections(id), ...terminalIds(id, outcome) });
}

function clearProjections(id: string): Partial<EnrollmentEngineState> {
  const patch: Partial<EnrollmentEngineState> = {};
  if (state.certificateReadyIds.includes(id)) {
    patch.certificateReadyIds = state.certificateReadyIds.filter((row) => row !== id);
  }
  if (state.invalidById[id]) {
    const next = { ...state.invalidById };
    delete next[id];
    patch.invalidById = next;
  }
  return patch;
}

function terminalIds(
  id: string,
  outcome: 'admitted' | 'expired' | 'cancelled'
): Partial<EnrollmentEngineState> {
  if (outcome === 'admitted') {
    const next = appendId(state.admittedIds, id);
    return next ? { admittedIds: next } : {};
  }
  if (outcome === 'expired') {
    const next = appendId(state.expiredIds, id);
    return next ? { expiredIds: next } : {};
  }
  const next = appendId(state.cancelledIds, id);
  return next ? { cancelledIds: next } : {};
}

// ---------------------------------------------------------------------------
// admit 流水线
// ---------------------------------------------------------------------------

/** 同一条 pending 同时只允许一次 admit 在飞；只用于去重与 `busyPendingId`。 */
const inFlight = new Set<string>();

/**
 * key log 写锁：**引擎级**一条 FIFO 链。
 *
 * head 是全局的，`keyLogHead → 构造签名 → append` 必须整段串行：两条不同 enrollment 的 admit
 * 若并行读到同一个 head，就会造出两条同 seq 的记录，hub 只收得下一条，另一条永久 `seq_gap`
 * （见 R4 #1）。按 enrollment 上锁挡不住这种情况。
 */
let keyLogQueue: Promise<unknown> = Promise.resolve();

function withKeyLogLock<T>(run: () => Promise<T>): Promise<T> {
  const result = keyLogQueue.then(run, run);
  keyLogQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** 锁 → 置忙 → 跑 → 无论如何解锁。锁拿到之后的每一句都在 `try` 里，异常不会把锁焊死。 */
async function runAdmit(id: string, run: () => Promise<void>): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    commit({ busyPendingId: id });
    await withKeyLogLock(run);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight.delete(id);
    if (state.busyPendingId === id) commit({ busyPendingId: null });
  }
}

/** 把一条**已签好**的 admit 记录送出去，并按 B2-6 的码处理结果。 */
async function submitAdmit(context: AdmitContext, id: string, record: SignedRecord): Promise<void> {
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
  finishPending(id, 'admitted');
  toast.success(context.t('nodes.enrollment.admitted'));
  fanOutDone();
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
  const id = pending.hubEnrollmentId;
  const head = headFromResponse(await context.api.keyLogHead());
  // 取 head 是异步的：这中间 pending 可能已被 admit / 取消，也可能已经过期。
  const live = livePending(id, pending.enrollPk);
  if (!live) return;
  if (isPendingExpired(live, nowMs())) {
    toast.error(context.t('nodes.enrollment.expired'));
    finishPending(id, 'expired');
    return;
  }
  const record = await buildAdmitNodeRecord({
    head,
    rootEpoch: requireRootEpoch(mode),
    uid: mode.uid,
    pending: live,
    certificateBytes,
    certSig,
    signer,
  });
  // 签名过程本身可能很久（passkey 仪式）：送出前再复核一次。
  if (!livePending(id, pending.enrollPk)) return;
  await submitAdmit(context, id, {
    bytes: encodeBase64url(record.bytes),
    sig: encodeBase64url(record.sig),
  });
}

/** 收到一张**有效**证书：记下「证书已到」，同时抹掉这条 id 之前的判定失败提示。 */
function markCertificateReady(id: string): void {
  const patch: Partial<EnrollmentEngineState> = {};
  const ready = appendId(state.certificateReadyIds, id);
  if (ready) patch.certificateReadyIds = ready;
  if (state.invalidById[id]) {
    const next = { ...state.invalidById };
    delete next[id];
    patch.invalidById = next;
  }
  if (ready || patch.invalidById) commit(patch);
}

function markInvalid(context: AdmitContext | null, id: string, reason: string): void {
  const key = invalidCertificateKey(reason);
  if (state.invalidById[id] === key) return;
  commit({ invalidById: { ...state.invalidById, [id]: key } });
  if (context) toast.error(context.t(key));
}

/** 轮询 / 推送检测出的结果。已过期或签名坏的直接告警；能自动签就自动签。 */
async function handleOutcome(outcome: CertificateOutcome): Promise<void> {
  if (outcome.kind === 'unknown') {
    const context = activeContext();
    if (context) toast.error(context.t('nodes.enrollment.unknownCertificate'));
    return;
  }
  const id = outcome.pending.hubEnrollmentId;
  // 结果可能来自一次陈旧的轮询：pending 已被推送 admit / 被取消时静默丢弃，不再告警。
  const pending = livePending(id, outcome.pending.enrollPk);
  if (!pending) return;
  if (outcome.kind === 'invalid') {
    markInvalid(activeContext(), id, outcome.reason);
    return;
  }
  markCertificateReady(id);
  // 去重在取签名者之前：重复的 outcome 不该白白消耗复用窗口里的凭证。
  if (inFlight.has(id)) return;
  const context = signingContext();
  if (!context) return;
  const signer = takeRememberedSigner(nowMs());
  // 复用窗口已过、或窗口里是 passkey：都留在「待确认」，等用户点按钮。
  if (admitPlan(id, canAutoSignAdmit(signer)) === 'wait') return;
  // 租约保证签名期间没有别的对话框实例把这把根钥清零。
  const release = signer ? leaseSigner(signer) : null;
  try {
    await runAdmit(id, () => admitInLock(context, id, outcome, signer));
  } finally {
    release?.();
  }
}

/** 临界区里的实际动作：先复核，再决定重发还是现签。 */
async function admitInLock(
  context: AdmitContext,
  id: string,
  outcome: Extract<CertificateOutcome, { kind: 'admit' }>,
  signer: RecordSigner | null
): Promise<void> {
  const live = livePending(id, outcome.pending.enrollPk);
  if (!live) return;
  const stored = unconfirmedRecord(id);
  // 手上还有未确认记录就只重发它：重签会按（可能已推进的）head 产生新 seq。
  if (stored) await submitAdmit(context, id, stored);
  else if (signer) {
    await signAdmit(context, live, outcome.certificateBytes, outcome.certSig, signer);
  }
}

/**
 * 「待确认 / 重试」按钮。**绑定发起它的那个槽位**：设置页点的按钮必须用设置页的凭据对话框、
 * hub 通道与翻译，不能撞上侧滑面板的（见 R4 #4）。
 *
 * 该 pending 手上还留着一条 hub 未确认的记录时，**只重发这份字节**：不要凭据、不取新 head、
 * 不重新签名。B2-6 保证未确认时服务端没落库，本地 head 没动，原记录仍然接得上；
 * 而重签会按（可能已推进的）本地 head 产生新 seq，一旦 hub 缺中间那条就永久拒绝。
 */
async function confirmFromSlot(slot: ContextSlot, id: string): Promise<void> {
  const context = slot.value;
  if (!context?.mode || !slots.includes(slot)) return;
  // 权威 pending 由 id 现取：调用方手里的那份可能已经是上一轮的残影。
  const pending = livePending(id);
  if (!pending) return;
  if (unconfirmedRecord(id)) {
    await runAdmit(id, () => resendInLock(slot, id, pending.enrollPk));
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
  // 凭据交互期间可能已被后台自动 admit / 被取消：复核之后才进临界区。
  if (!slots.includes(slot) || !livePending(id, pending.enrollPk)) return;
  const release = leaseSigner(signer);
  try {
    await runAdmit(id, () => confirmInLock(slot, id, pending.enrollPk, signer));
  } finally {
    release();
  }
}

async function resendInLock(slot: ContextSlot, id: string, enrollPk: string): Promise<void> {
  const context = slot.value;
  if (!context || !slots.includes(slot)) return;
  if (!livePending(id, enrollPk)) return;
  const stored = unconfirmedRecord(id);
  if (stored) await submitAdmit(context, id, stored);
}

async function confirmInLock(
  slot: ContextSlot,
  id: string,
  enrollPk: string,
  signer: RecordSigner
): Promise<void> {
  const context = slot.value;
  if (!context || !slots.includes(slot) || !livePending(id, enrollPk)) return;
  const hubApi = activeHubApi();
  const pending = livePending(id, enrollPk);
  if (!pending) return;
  const candidates = hubApi ? await collectRedeemedCertificates(hubApi, [pending]) : [];
  const fresh = livePending(id, enrollPk);
  if (!fresh || !slots.includes(slot)) return;
  for (const candidate of candidates) {
    const outcome = offerCertificate([fresh], candidate, nowMs());
    if (outcome.kind === 'admit') {
      markCertificateReady(id);
      await signAdmit(context, fresh, outcome.certificateBytes, outcome.certSig, signer);
      return;
    }
    if (outcome.kind === 'invalid') {
      markInvalid(context, id, outcome.reason);
      return;
    }
  }
  toast.error(context.t('nodes.enrollment.noCertificateYet'));
}

/** 取消只删本地 pending（hub 侧记录会自然过期），同时让对应的 join 串立刻消失。 */
export function cancelPending(pending: { hubEnrollmentId: string }): void {
  finishPending(pending.hubEnrollmentId, 'cancelled');
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

/**
 * 注册一个 admit 上下文并在挂载期间维持监听回路，返回**绑定到本槽位**的动作。
 *
 * 槽位值只在提交阶段写：渲染期写会让被 React 丢弃的那次渲染污染引擎依赖。
 * 槽位身份在整个挂载期不变——注销时准确回落到上一个消费方。
 */
export function useEnrollmentEngine(context: AdmitContext): EnrollmentEngineHandle {
  const slot = useRef<ContextSlot>({ value: null });
  useEffect(() => {
    slot.current.value = context;
  });
  // 只在挂载 / 卸载时接线；槽位值由上面那个提交阶段 effect 负责（它先于本 effect 跑）。
  useEffect(() => attachSlot(slot.current), []);
  const confirmManually = useCallback(
    (enrollmentId: string) => confirmFromSlot(slot.current, enrollmentId),
    []
  );
  return { confirmManually };
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

/** 复合重置：引擎投影 + 协作 store（pending 存储、未确认记录、凭据复用窗口）一并归零。 */
export function resetEnrollmentEngineForTest(): void {
  stopWatch();
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  unsubscribePendings?.();
  unsubscribePendings = null;
  slots.length = 0;
  inFlight.clear();
  keyLogQueue = Promise.resolve();
  ticking = false;
  overrides = {};
  clearUnconfirmedRecords();
  clearPendingEnrollments();
  forgetSigner();
  state = EMPTY_STATE;
  notify();
}
