// 一次加入对用户可见的进度：准入 → 下发成员密钥 → 完成 / 成员密钥待补发。
//
// 中继模式下加入要签两条记录：`admit-node` 与把成员密钥交给新节点的 `meta-key`。每条记录的
// passkey 断言都以该记录的摘要为 challenge，一次断言罩不住两条，所以 passkey 用户必然验证两次。
// 这里把两条收成**一次**操作：「节点已加入」只在第二条也落账后报一次；第二条没签成时节点其实
// 已经加入，状态停在 `keyPending`，补发只需要再验证一次。
//
// 进度写进引擎的状态 store（`progressById` / `failureById`），设置页与接入面板读同一份。
//
// 停在 `keyPending` 的那几条还要与服务端真相对账：成员密钥可能由常驻重试回路、别的标签页或
// 别的设备补上，中继状态里不再欠着就收成已加入（见 `reconcileMemberKeys`）。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import { WebAuthnError } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { toast } from 'sonner';
import {
  type AdmitProgress,
  commitEnrollmentEngine,
  getEnrollmentEngineState,
} from './enrollment-engine-state';
import { getMeshRelayState, isRelayMode, subscribeMeshRelay } from './mesh-relay';
import { PASSKEY_ABORTED } from './relay-enroll';

export type AdmitFollowUpResult = { ok: true } | { ok: false; code: string };

/** 第二步的收场：成功 / 失败（带错误码）/ 用户自己取消了验证。 */
type MemberKeyOutcome = AdmitFollowUpResult | 'cancelled';

/**
 * admit 落账之后的那一步。`signer` 为 `null` 时由实现从复用窗口取 admit 刚用过的那把；
 * `nodeIdHex` 为 `null`（重发路径解不出 node id）时按服务端的欠账名单补。
 */
export type AdmitFollowUp = (
  nodeIdHex: string | null,
  signer: RecordSigner | null
) => Promise<AdmitFollowUpResult>;

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface MemberKeyStep {
  id: string;
  followUp: AdmitFollowUp;
  t: Translate;
  /** 成员密钥落账后刷新各处列表。 */
  onDone: () => void;
}

function progressOf(id: string): AdmitProgress | null {
  return getEnrollmentEngineState().progressById[id] ?? null;
}

function writeProgress(id: string, next: AdmitProgress | null): void {
  const progressById = { ...getEnrollmentEngineState().progressById };
  if (next) progressById[id] = next;
  else delete progressById[id];
  commitEnrollmentEngine({ progressById });
}

function patchProgress(id: string, patch: Partial<AdmitProgress>): void {
  const current = progressOf(id);
  if (current) writeProgress(id, { ...current, ...patch });
}

/** 一次确认开始：进入第一步，并清掉上一次留下的失败提示。 */
export function beginAdmit(id: string, name: string | null, twoStep: boolean): void {
  const state = getEnrollmentEngineState();
  const failureById = { ...state.failureById };
  delete failureById[id];
  const progress: AdmitProgress = {
    phase: 'admitting',
    steps: twoStep ? 2 : 1,
    name,
    nodeId: null,
  };
  commitEnrollmentEngine({ failureById, progressById: { ...state.progressById, [id]: progress } });
}

/** 这次确认没有落账（失败 / 上级未确认 / 被复核丢弃）：撤掉进度，行回到待确认。 */
export function abandonAdmit(id: string): void {
  if (progressOf(id)?.phase === 'admitting') writeProgress(id, null);
}

/** 记下行内失败提示并告警一次。`text` 给了就用它做 toast（错误码没有对应文案时的兜底）。 */
export function failAdmit(t: Translate, id: string, key: string, text = t(key)): void {
  const state = getEnrollmentEngineState();
  commitEnrollmentEngine({ failureById: { ...state.failureById, [id]: key } });
  toast.error(text);
}

function isCeremonyAbort(err: unknown): boolean {
  return err instanceof WebAuthnError && err.code === 'aborted';
}

/** 抛出来的异常（超时 / 断网 / 仪式被取消）一律换成成句的提示，不把原始报错摆给用户。 */
export function admitErrorKey(err: unknown): string {
  return isCeremonyAbort(err) ? 'auth.errors.PASSKEY_ABORTED' : 'nodes.enrollment.admitFailed';
}

/**
 * 确认途中抛出来的异常：行内给成句的提示，原始报错留在控制台供排查（用户自己取消仪式不算故障）。
 * `t` 为 `null` 表示这次操作已经作废，只留痕、不往界面上写。
 */
export function reportAdmitError(t: Translate | null, id: string, err: unknown): void {
  if (!isCeremonyAbort(err)) console.warn('[enroll] admit failed', err);
  if (t) failAdmit(t, id, admitErrorKey(err));
}

export function markAdmitExpired(id: string, name: string | null): void {
  writeProgress(id, { phase: 'expired', steps: 1, name, nodeId: null });
}

/** 没有第二步：admit 落账即完成。 */
export function completeAdmit(t: Translate, id: string): void {
  patchProgress(id, { phase: 'done' });
  toast.success(t('nodes.enrollment.admitted'));
}

/** admit 已落账、成员密钥还没签：进入第二步。 */
export function awaitMemberKey(id: string, nodeId: string | null): void {
  patchProgress(id, { phase: 'distributing', steps: 2, nodeId });
}

/** 停在待补发的那几条：对账收尾时要用当初那一步的翻译与刷新。`since` 之后的中继状态才作数。 */
const heldSteps = new Map<string, { step: MemberKeyStep; since: number }>();
let stopReconcile: (() => void) | null = null;

function syncReconcile(): void {
  if (heldSteps.size > 0) {
    stopReconcile ??= subscribeMeshRelay(reconcileMemberKeys);
    return;
  }
  stopReconcile?.();
  stopReconcile = null;
}

async function runFollowUp(
  step: MemberKeyStep,
  signer: RecordSigner | null
): Promise<MemberKeyOutcome> {
  let result: AdmitFollowUpResult;
  try {
    result = await step.followUp(progressOf(step.id)?.nodeId ?? null, signer);
  } catch (err) {
    if (isCeremonyAbort(err)) return 'cancelled';
    console.warn('[enroll] member key step failed', err);
    return { ok: false, code: errorMessage(err) };
  }
  return !result.ok && result.code === PASSKEY_ABORTED ? 'cancelled' : result;
}

function finishMemberKey(step: MemberKeyStep): void {
  heldSteps.delete(step.id);
  syncReconcile();
  patchProgress(step.id, { phase: 'done', keyError: undefined });
  toast.success(step.t('nodes.enrollment.admitted'));
  step.onDone();
}

/**
 * 第二步收场。没落账就停在待补发：失败记下错误码供行内显示，用户自己取消的不记。
 * `announce` 为假时不再告警（补发时取消凭据框：用户清楚自己做了什么）。
 */
function settleMemberKey(step: MemberKeyStep, outcome: MemberKeyOutcome, announce: boolean): void {
  if (outcome !== 'cancelled' && outcome.ok) {
    finishMemberKey(step);
    return;
  }
  const keyError = outcome === 'cancelled' ? undefined : outcome.code;
  patchProgress(step.id, { phase: 'keyPending', keyError });
  // 补发没成不重置起点：此前已经看到「不欠了」的状态依然作数。
  heldSteps.set(step.id, { step, since: heldSteps.get(step.id)?.since ?? Date.now() });
  syncReconcile();
  if (announce) toast.warning(step.t('nodes.enrollment.memberKeyPending'));
}

/**
 * 第二步：紧跟 admit 下发成员密钥，签名者沿用 admit 那一把。
 *
 * `auto` 为假（这次 admit 不是用户手势发起的，手上又不是根钥）时不跑：passkey 仪式从定时器里
 * 发起会被浏览器拒掉，直接停在待补发，由用户点「补发成员密钥」。
 */
export async function distributeMemberKey(step: MemberKeyStep, auto: boolean): Promise<void> {
  settleMemberKey(step, auto ? await runFollowUp(step, null) : 'cancelled', true);
}

/** 「补发成员密钥」：只补第二步那一条记录，凭据当场要、用完即清。 */
export async function resendMemberKey(
  step: MemberKeyStep,
  prompt: CredentialPromptHandle
): Promise<void> {
  if (progressOf(step.id)?.phase !== 'keyPending') return;
  patchProgress(step.id, { phase: 'distributing', keyError: undefined });
  let outcome: MemberKeyOutcome;
  try {
    const result = await prompt.withSigner((signer) => runFollowUp(step, signer), {
      purpose: 'admit',
    });
    outcome = result ?? 'cancelled';
  } catch (err) {
    console.warn('[enroll] member key resend failed', err);
    outcome = { ok: false, code: errorMessage(err) };
  }
  settleMemberKey(step, outcome, outcome !== 'cancelled');
  // 等凭据的这段时间里别处可能已经补上了：取消之后当场再对一次，不必等下一拍轮询。
  if (outcome === 'cancelled') reconcileMemberKeys();
}

function deliveredElsewhere(
  progress: AdmitProgress,
  since: number,
  relay: ReturnType<typeof getMeshRelayState>
): boolean {
  if (!progress.nodeId || !isRelayMode(relay)) return false;
  // 只认停在待补发**之后才发出**的请求：更早发出的那份里新节点可能还没进成员表，自然也不在欠账名单上。
  if (relay.requestedAt === null || relay.requestedAt <= since) return false;
  return !relay.metaKeyLagging.some((row) => row.nodeId === progress.nodeId);
}

/**
 * 与服务端真相对账：停在待补发的节点已经不在 `metaKeyLagging` 里（常驻重试回路把已签字节送到了、
 * 或别的标签页 / 设备补发了），就收成已加入并报那一次「节点已加入」。解不出 node id 的那几条
 * 对不上名单，仍由告警条的补发结果收尾（`markMemberKeysDelivered`）。
 */
export function reconcileMemberKeys(): void {
  const relay = getMeshRelayState();
  for (const [id, held] of [...heldSteps]) {
    const progress = progressOf(id);
    // 正在补发的那条由补发自己收场。
    if (progress?.phase === 'distributing') continue;
    if (progress?.phase !== 'keyPending') heldSteps.delete(id);
    else if (deliveredElsewhere(progress, held.since, relay)) finishMemberKey(held.step);
  }
  syncReconcile();
}

/**
 * 结果行自己管着的那几台（正在下发 / 待补发：行上有进度或补发按钮）不再进告警条，
 * 同一台节点只留一个补发入口。
 */
export function withoutRowOwned<T extends { nodeId: string }>(
  lagging: T[],
  rows: readonly (AdmitProgress | undefined)[]
): T[] {
  const owned = new Set<string>();
  for (const row of rows) {
    if (row?.nodeId && (row.phase === 'distributing' || row.phase === 'keyPending')) {
      owned.add(row.nodeId);
    }
  }
  return owned.size === 0 ? lagging : lagging.filter((node) => !owned.has(node.nodeId));
}

/**
 * 告警条「补发成员密钥」补成了哪几台：把对应的待补发结果收成已加入。
 * 解不出 node id 的那几条只在整轮全部补成（`all`）时才算数。
 */
export function markMemberKeysDelivered(nodeIds: readonly string[], all: boolean): void {
  const current = getEnrollmentEngineState().progressById;
  const progressById = { ...current };
  let changed = false;
  for (const [id, progress] of Object.entries(current)) {
    if (progress.phase !== 'keyPending') continue;
    if (progress.nodeId ? !nodeIds.includes(progress.nodeId) : !all) continue;
    progressById[id] = { ...progress, phase: 'done', keyError: undefined };
    changed = true;
  }
  if (changed) commitEnrollmentEngine({ progressById });
}

/** 关掉一条结果行；还在进行中的不让关。 */
export function dismissAdmitProgress(id: string): void {
  const phase = progressOf(id)?.phase;
  if (phase === 'done' || phase === 'keyPending' || phase === 'expired') writeProgress(id, null);
}

export function resetAdmitProgressForTest(): void {
  heldSteps.clear();
  syncReconcile();
}
