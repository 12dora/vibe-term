/**
 * 一次加入对用户可见的阶段。`admittedIds` 只说明 `admit-node` 已落账；中继模式下还要再签一条
 * `meta-key` 把成员密钥交给新节点，两条都落账才算 `done`。
 */
export type AdmitPhase = 'admitting' | 'distributing' | 'done' | 'keyPending' | 'expired';

export interface AdmitProgress {
  phase: AdmitPhase;
  /** 本次加入要签几条记录：中继模式 2，其余 1。 */
  steps: 1 | 2;
  /** pending 收尾后就查不到了，结果行靠这里留名。 */
  name: string | null;
  nodeId: string | null;
  /** `keyPending` 时第二步失败的错误码；用户自己取消的不算失败，不记。 */
  keyError?: string;
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
  /**
   * 上级未确认、手上还留着一份可重发记录的 pending id。
   * 语义：`hubAck === false` 或 `relayAck === false`（`hubAck` 是冻结的 legacy 响应字段名）。
   */
  unconfirmedIds: string[];
  /** 已收到**有效**证书、等待签 admit 的 pending id（passkey 用户要手动点确认）。 */
  certificateReadyIds: string[];
  /** 证书判定失败的 pending id → 提示用的 i18n key。 */
  invalidById: Record<string, string>;
  /** 最近一次确认失败的 pending id → 行内提示用的 i18n key；下一次确认开始时清掉。 */
  failureById: Record<string, string>;
  /** 加入进度与结果，按 enrollment id；结果留到用户关掉为止。 */
  progressById: Record<string, AdmitProgress>;
}

const EMPTY_STATE: EnrollmentEngineState = {
  busyPendingId: null,
  busyIds: [],
  admittedIds: [],
  expiredIds: [],
  cancelledIds: [],
  clearedIds: [],
  unconfirmedIds: [],
  certificateReadyIds: [],
  invalidById: {},
  failureById: {},
  progressById: {},
};

let state: EnrollmentEngineState = EMPTY_STATE;
const listeners = new Set<() => void>();

/** 一个订阅者抛异常不能把后面的订阅者和调用方一起带走（调用方常在 `finally` 之前）。 */
export function notifyEnrollmentEngine(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 订阅者自己的渲染错误由 React 的错误边界处理，引擎只保证状态一致。
    }
  }
}

export function commitEnrollmentEngine(patch: Partial<EnrollmentEngineState>): void {
  const next = { ...state, ...patch };
  if (patch.admittedIds || patch.expiredIds || patch.cancelledIds) {
    next.clearedIds = [...next.admittedIds, ...next.expiredIds, ...next.cancelledIds];
  }
  state = next;
  notifyEnrollmentEngine();
}

export function appendId(list: string[], id: string): string[] | null {
  return list.includes(id) ? null : [...list, id];
}

export function getEnrollmentEngineState(): EnrollmentEngineState {
  return state;
}

function withoutKey<T>(map: Record<string, T>, id: string): Record<string, T> | null {
  if (!(id in map)) return null;
  const next = { ...map };
  delete next[id];
  return next;
}

/** 这条 id 的全部过程投影（证书已到 / 判定失败 / 确认失败）；终态与取消时一并清掉。 */
function clearProjections(id: string): Partial<EnrollmentEngineState> {
  const patch: Partial<EnrollmentEngineState> = {};
  if (state.certificateReadyIds.includes(id)) {
    patch.certificateReadyIds = state.certificateReadyIds.filter((row) => row !== id);
  }
  const invalidById = withoutKey(state.invalidById, id);
  if (invalidById) patch.invalidById = invalidById;
  const failureById = withoutKey(state.failureById, id);
  if (failureById) patch.failureById = failureById;
  return patch;
}

const TERMINAL_FIELD = {
  admitted: 'admittedIds',
  expired: 'expiredIds',
  cancelled: 'cancelledIds',
} as const;

/** 进入终态：记进对应的 id 列表，并清掉这条 id 的过程投影。 */
export function commitTerminal(id: string, outcome: keyof typeof TERMINAL_FIELD): void {
  const field = TERMINAL_FIELD[outcome];
  const patch = clearProjections(id);
  const next = appendId(state[field], id);
  if (next) patch[field] = next;
  commitEnrollmentEngine(patch);
}

/** 手动确认时证书还没到；证书一到这句就过时了。 */
export const NO_CERTIFICATE_YET_KEY = 'nodes.enrollment.noCertificateYet';

/**
 * 收到一张**有效**证书：记下「证书已到」，同时抹掉这条 id 之前的判定失败提示与「新节点尚未响应」。
 * 其它确认失败的提示不动：轮询每拍都会走到这里，一并清掉等于失败原因只显示几秒。
 */
export function markCertificateReady(id: string): void {
  const patch: Partial<EnrollmentEngineState> = {};
  const ready = appendId(state.certificateReadyIds, id);
  if (ready) patch.certificateReadyIds = ready;
  const invalidById = withoutKey(state.invalidById, id);
  if (invalidById) patch.invalidById = invalidById;
  if (state.failureById[id] === NO_CERTIFICATE_YET_KEY) {
    patch.failureById = withoutKey(state.failureById, id) ?? state.failureById;
  }
  if (Object.keys(patch).length > 0) commitEnrollmentEngine(patch);
}

/** 记下证书判定失败的提示 key；与上一次相同返回 `false`，调用方据此不重复告警。 */
export function markCertificateInvalid(id: string, key: string): boolean {
  if (state.invalidById[id] === key) return false;
  commitEnrollmentEngine({ invalidById: { ...state.invalidById, [id]: key } });
  return true;
}

export function subscribeEnrollmentEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setEnrollmentEngineStateForTest(patch: Partial<EnrollmentEngineState>): void {
  commitEnrollmentEngine(patch);
}

export function resetEnrollmentEngineState(): void {
  state = EMPTY_STATE;
  notifyEnrollmentEngine();
}
