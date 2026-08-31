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
//   - 每条 admit 是一次带**不可变上下文快照**的事务：只认快照里的 api / hub 通道 / 用户身份，
//     槽位换人或引擎重置都不会让它写进新状态；
//   - 取消在事务期间只记意向，等处置明朗再兑现，绝不在 append 未定之前扔掉可重发字节；
//   - 手动确认绑定发起它的那个消费方槽位，后台自动签则挑一个凭据齐备的槽位。

import {
  forgetSigner,
  leaseSigner,
  resetSignerLeasesForTest,
  takeRememberedSigner,
} from '@/auth/credential-prompt';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import type { KeyLogHead } from '@tmex/shared/auth';
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

/** 一张确认可用的证书 + 它属于的那条 pending。 */
type AdmitOutcome = Extract<CertificateOutcome, { kind: 'admit' }>;

/**
 * 引擎代次，`resetEnrollmentEngineForTest()` 会 +1。重置**不等待也不中断**已发出的请求
 * （`AuthApi` 没有 abort 通道）：飞行中的操作各自带着代次，对不上就整条作废（见 R5 #9）。
 */
let engineGeneration = 0;

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
  /** 最近一条正在跑 admit 的 pending id（`busyIds` 的末位）。 */
  busyPendingId: string | null;
  /** **全部**正在跑 admit 的 pending id：多条同时在飞时，按钮禁用要逐条判。 */
  busyIds: string[];
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
  busyIds: [],
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
  /** 槽位身份代次：api / hub 通道 / 用户身份换了就 +1，飞行中的操作据此作废自己。 */
  generation: number;
}

const slots: ContextSlot[] = [];

/** 槽位身份：只看会影响一条 admit 结果的字段（`prompt` / `t` 每次渲染都换新对象，不算）。 */
function sameSlotIdentity(a: AdmitContext | null, b: AdmitContext | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.api === b.api &&
    a.hubApi === b.hubApi &&
    a.mode?.uid === b.mode?.uid &&
    a.mode?.rootEpoch === b.mode?.rootEpoch
  );
}

function writeSlot(slot: ContextSlot, value: AdmitContext | null): void {
  if (!sameSlotIdentity(slot.value, value)) slot.generation += 1;
  slot.value = value;
}

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
function signingSlot(): ContextSlot | null {
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].value?.mode) return slots[i];
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

/** 注册一个 admit 上下文；`release()` 注销，`update()` 换一份（换 hub / 换用户）。 */
export function registerAdmitContext(
  context: AdmitContext
): EnrollmentEngineHandle & { release: () => void; update: (next: AdmitContext) => void } {
  const slot: ContextSlot = { value: context, generation: 0 };
  const detach = attachSlot(slot);
  return {
    confirmManually: (enrollmentId: string) => confirmFromSlot(slot, enrollmentId),
    update: (next: AdmitContext) => writeSlot(slot, next),
    release: detach,
  };
}

/**
 * 一次 admit 操作的**不可变**上下文快照。一条 admit 跨好几段 await（凭据交互、取 head、
 * 签名、append），期间槽位可能被重新赋值、引擎可能被重置：整条操作只认这份快照，
 * hub 通道也只用快照里的，不再中途回头取 `activeHubApi()`（见 R5「拼接两个上下文」）。
 */
interface OperationContext {
  api: AuthApi;
  hubApi: HubApi | null;
  mode: AdmitMode;
  prompt: CredentialPromptHandle;
  t: AdmitContext['t'];
  /** 签名者取用口：自动路径到用时才从复用窗口现取，手动路径固定用刚拿到的那个。 */
  signer: () => RecordSigner | null;
  slot: ContextSlot;
  slotGeneration: number;
  engineGeneration: number;
}

function openOperation(
  slot: ContextSlot,
  signer: () => RecordSigner | null
): OperationContext | null {
  const value = slot.value;
  if (!value?.mode || !slots.includes(slot)) return null;
  return {
    api: value.api,
    // 槽位自己还没定位到 hub 时只在**这一刻**回落一次，此后整条操作都认这一个通道。
    hubApi: value.hubApi ?? activeHubApi(),
    mode: value.mode,
    prompt: value.prompt,
    t: value.t,
    signer,
    slot,
    slotGeneration: slot.generation,
    engineGeneration,
  };
}

/** 快照是否仍然有效：引擎没被重置、槽位还在、槽位身份也没换过。 */
function opAlive(op: OperationContext): boolean {
  return (
    op.engineGeneration === engineGeneration &&
    op.slot.generation === op.slotGeneration &&
    slots.includes(op.slot)
  );
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
function finishPending(
  id: string,
  outcome: 'admitted' | 'expired' | 'cancelled',
  nodeIdHex?: string
): void {
  forgetUnconfirmedRecord(id);
  if (livePending(id)) removePendingEnrollment(id);
  if (nodeIdHex) admittedNodeIds.set(id, nodeIdHex);
  commit({ ...clearProjections(id), ...terminalIds(id, outcome) });
}

/**
 * 已 admit 的 enrollment → 新节点的 node id（来自证书）。侧滑面板拿它把「已加入」标记
 * 与真实成员集对账；重发路径手上只有已签字节、没有证书，这种情况下没有条目。
 */
const admittedNodeIds = new Map<string, string>();

export function admittedNodeIdFor(enrollmentId: string): string | null {
  return admittedNodeIds.get(enrollmentId) ?? null;
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

/** 一条 admit 的事务状态。`cancelRequested` 只是意向，等处置明朗之后才兑现。 */
interface AdmitTransaction {
  cancelRequested: boolean;
}

/** 同一条 pending 同时只允许一次 admit 在飞；也是 `busyIds` 的唯一来源。 */
const transactions = new Map<string, AdmitTransaction>();

function commitBusy(): void {
  const busyIds = [...transactions.keys()];
  commit({ busyIds, busyPendingId: busyIds.at(-1) ?? null });
}

/**
 * key log 写锁：**引擎级**一条 FIFO 链。
 *
 * head 是全局的，`keyLogHead → 构造签名 → append` 必须整段串行：两条不同 enrollment 的 admit
 * 若并行读到同一个 head，就会造出两条同 seq 的记录，hub 只收得下一条，另一条永久 `seq_gap`
 * （见 R4 #1）。按 enrollment 上锁挡不住这种情况。
 *
 * 导出给 `node/` 之外的写入方（吊销在 `use-node-row-actions.ts`）：它们与 admit 抢同一个
 * head，不进这条链照样撞（见 R5 #1）。**只圈住取 head → 签名 → append**，凭据对话框留锁外。
 */
let keyLogQueue: Promise<unknown> = Promise.resolve();

export function withKeyLogLock<T>(run: () => Promise<T>): Promise<T> {
  const result = keyLogQueue.then(run, run);
  keyLogQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** 开事务 → 置忙 → 跑 → 无论如何收尾。锁拿到之后的每一句都在 `try` 里，异常不会把锁焊死。 */
async function runAdmit(op: OperationContext, id: string, run: () => Promise<void>): Promise<void> {
  if (transactions.has(id)) return;
  const txn: AdmitTransaction = { cancelRequested: false };
  transactions.set(id, txn);
  try {
    commitBusy();
    await withKeyLogLock(run);
  } catch (err) {
    if (opAlive(op)) toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    if (transactions.get(id) === txn) transactions.delete(id);
    // 引擎已被重置：这条操作属于上一代，不再往新状态上写任何东西。
    if (op.engineGeneration === engineGeneration) {
      commitBusy();
      if (txn.cancelRequested) applyDeferredCancel(id);
    }
  }
}

/**
 * 事务期间按下的取消，等处置明朗了才兑现：
 * - 已 admit 成功：这条 enrollment 已经成了，按已加入处理，不做回退；
 * - 还留着未确认记录（请求抛异常 / hub 没答应）：pending 与字节都留着交给重发路径对账，
 *   现在删掉就再也送不进 hub（见 R5 Blocker）；
 * - 其余（终态拒绝、根本没送出去）：照常取消并清干净。
 */
function applyDeferredCancel(id: string): void {
  if (state.admittedIds.includes(id)) return;
  if (unconfirmedRecord(id)) return;
  finishPending(id, 'cancelled');
}

/** 把一条**已签好**的 admit 记录送出去，并按 B2-6 的码处理结果。 */
async function submitAdmit(
  op: OperationContext,
  id: string,
  record: SignedRecord,
  nodeIdHex?: string
): Promise<void> {
  // hub=sync：entry 先把记录送 hub 并等 ack，确认之前本地什么都不写。
  const disposition = await submitAdmitRecord(op.api, id, record);
  // 引擎被重置 / 槽位换了人：结果照常由 `submitAdmitRecord` 记账，但不再投影到新状态。
  if (!opAlive(op)) return;
  if (disposition.kind === 'unconfirmed') {
    // hub 没确认就删 pending 会把 enroll 授权丢掉，而新 node 永远成不了 mesh 成员。
    toast.warning(op.t('nodes.enrollment.hubNotConfirmed'));
    return;
  }
  if (disposition.kind === 'stale') {
    // fork / seq_gap：这份字节永远不会被接受，让用户重新签一条。
    toast.error(op.t('nodes.enrollment.staleRecord'));
    return;
  }
  if (disposition.kind === 'error') {
    toast.error(op.t(`auth.errors.${disposition.code}`, { defaultValue: disposition.code }));
    return;
  }
  finishPending(id, 'admitted', nodeIdHex);
  toast.success(op.t('nodes.enrollment.admitted'));
  fanOutDone();
}

/**
 * 租约只罩住「取签名者 → 构造签名」这一小段：排队等锁与网络提交期间都不占着根钥，
 * 否则前置操作卡死就把一份根私钥无限期留在堆里（见 R5）。签名者也到这一刻才现取——
 * 复用窗口可能在排队期间已被清掉，那就不签，绝不用抹成 0 的 seed 签出一条废记录。
 */
async function buildRecord(
  op: OperationContext,
  pending: PendingEnrollment,
  outcome: AdmitOutcome,
  head: KeyLogHead
): Promise<SignedRecord | null> {
  const signer = op.signer();
  if (!signer) return null;
  const release = leaseSigner(signer);
  try {
    const record = await buildAdmitNodeRecord({
      head,
      rootEpoch: requireRootEpoch(op.mode),
      uid: op.mode.uid,
      pending,
      certificateBytes: outcome.certificateBytes,
      certSig: outcome.certSig,
      signer,
    });
    return { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) };
  } finally {
    release();
  }
}

async function signAdmit(
  op: OperationContext,
  pending: PendingEnrollment,
  outcome: AdmitOutcome
): Promise<void> {
  const id = pending.hubEnrollmentId;
  const head = headFromResponse(await op.api.keyLogHead());
  // 取 head 是异步的：这中间 pending 可能已被 admit / 取消，也可能已经过期。
  const live = opAlive(op) ? livePending(id, pending.enrollPk) : null;
  if (!live) return;
  if (isPendingExpired(live, nowMs())) {
    toast.error(op.t('nodes.enrollment.expired'));
    finishPending(id, 'expired');
    return;
  }
  const record = await buildRecord(op, live, outcome, head);
  if (!record) return;
  // 签名过程本身可能很久（passkey 仪式）：送出前再复核一次。
  if (!opAlive(op) || !livePending(id, pending.enrollPk)) return;
  await submitAdmit(op, id, record, outcome.nodeIdHex);
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

function markInvalid(t: AdmitContext['t'] | null, id: string, reason: string): void {
  const key = invalidCertificateKey(reason);
  if (state.invalidById[id] === key) return;
  commit({ invalidById: { ...state.invalidById, [id]: key } });
  if (t) toast.error(t(key));
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
    markInvalid(activeContext()?.t ?? null, id, outcome.reason);
    return;
  }
  markCertificateReady(id);
  // 去重在取签名者之前：重复的 outcome 不该白白消耗复用窗口里的凭证。
  if (transactions.has(id)) return;
  const slot = signingSlot();
  if (!slot) return;
  // 复用窗口已过、或窗口里是 passkey：都留在「待确认」，等用户点按钮。
  if (admitPlan(id, canAutoSignAdmit(takeRememberedSigner(nowMs()))) === 'wait') return;
  const op = openOperation(slot, () => takeRememberedSigner(nowMs()));
  if (!op) return;
  await runAdmit(op, id, () => admitInLock(op, id, outcome));
}

/** 临界区里的实际动作：先复核，再决定重发还是现签。 */
async function admitInLock(op: OperationContext, id: string, outcome: AdmitOutcome): Promise<void> {
  const live = opAlive(op) ? livePending(id, outcome.pending.enrollPk) : null;
  if (!live) return;
  const stored = unconfirmedRecord(id);
  // 手上还有未确认记录就只重发它：重签会按（可能已推进的）head 产生新 seq。
  if (stored) await submitAdmit(op, id, stored, outcome.nodeIdHex);
  else await signAdmit(op, live, outcome);
}

/**
 * 「待确认 / 重试」按钮。**绑定发起它的那个槽位**：设置页点的按钮必须用设置页的凭据对话框、
 * hub 通道与翻译，不能撞上侧滑面板的（见 R4 #4）。这些字段在操作一开始就冻成快照（见 R5 #4）。
 *
 * 该 pending 还留着一条 hub 未确认的记录时，**只重发这份字节**：不要凭据、不取新 head、
 * 不重签，也不占租约。B2-6 保证未确认时服务端没落库，原记录仍然接得上；而重签会按
 * （可能已推进的）本地 head 产生新 seq，一旦 hub 缺中间那条就永久拒绝。
 */
async function confirmFromSlot(slot: ContextSlot, id: string): Promise<void> {
  // 权威 pending 由 id 现取：调用方手里的那份可能已经是上一轮的残影。
  const pending = livePending(id);
  if (!pending) return;
  const enrollPk = pending.enrollPk;
  let signer: RecordSigner | null = null;
  const op = openOperation(slot, () => signer);
  if (!op) return;
  if (unconfirmedRecord(id)) {
    await runAdmit(op, id, () => resendInLock(op, id, enrollPk));
    return;
  }
  try {
    // request() 会把签名者放进 5 分钟复用窗口，后续自动 admit 直接用它。
    signer = await op.prompt.request({ purpose: 'admit', reuse: true });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!signer) return;
  // 凭据交互期间可能已被后台自动 admit / 被取消，槽位也可能换了 hub 或换了用户。
  if (!opAlive(op) || !livePending(id, enrollPk)) return;
  await runAdmit(op, id, () => confirmInLock(op, id, enrollPk));
}

async function resendInLock(op: OperationContext, id: string, enrollPk: string): Promise<void> {
  if (!opAlive(op) || !livePending(id, enrollPk)) return;
  const stored = unconfirmedRecord(id);
  if (stored) await submitAdmit(op, id, stored);
}

async function confirmInLock(op: OperationContext, id: string, enrollPk: string): Promise<void> {
  const pending = opAlive(op) ? livePending(id, enrollPk) : null;
  if (!pending) return;
  // hub 通道用快照里的那个，不回头取全局「最近一个」（见 R5 #4）。
  const candidates = op.hubApi ? await collectRedeemedCertificates(op.hubApi, [pending]) : [];
  const fresh = opAlive(op) ? livePending(id, enrollPk) : null;
  if (!fresh) return;
  for (const candidate of candidates) {
    const outcome = offerCertificate([fresh], candidate, nowMs());
    if (outcome.kind === 'admit') {
      markCertificateReady(id);
      await signAdmit(op, fresh, outcome);
      return;
    }
    if (outcome.kind === 'invalid') {
      markInvalid(op.t, id, outcome.reason);
      return;
    }
  }
  toast.error(op.t('nodes.enrollment.noCertificateYet'));
}

/**
 * 取消只删本地 pending（hub 侧记录会自然过期），同时让对应的 join 串立刻消失。
 * 这条 pending 正在跑事务时**只记意向**：字节可能正在 append 途中，现在删掉，
 * 一旦请求抛异常就再也重发不出去（见 R5 Blocker）。
 */
export function cancelPending(pending: { hubEnrollmentId: string }): void {
  const id = pending.hubEnrollmentId;
  const txn = transactions.get(id);
  if (txn) {
    txn.cancelRequested = true;
    return;
  }
  finishPending(id, 'cancelled');
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
  const slot = useRef<ContextSlot>({ value: null, generation: 0 });
  useEffect(() => {
    writeSlot(slot.current, context);
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

/**
 * 复合重置：引擎投影 + 协作 store（pending 存储、未确认记录、凭据复用窗口、租约簿记）归零。
 *
 * 先把代次 +1：还在飞的操作回来时属于上一代，既不提交状态也不发提示。重置本身不 await、
 * 不中断任何 I/O——`AuthApi` 没有 abort 通道，硬等只会把测试挂住。
 */
export function resetEnrollmentEngineForTest(): void {
  engineGeneration += 1;
  stopWatch();
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  unsubscribePendings?.();
  unsubscribePendings = null;
  slots.length = 0;
  transactions.clear();
  admittedNodeIds.clear();
  keyLogQueue = Promise.resolve();
  ticking = false;
  overrides = {};
  clearUnconfirmedRecords();
  clearPendingEnrollments();
  forgetSigner();
  resetSignerLeasesForTest();
  state = EMPTY_STATE;
  notify();
}
