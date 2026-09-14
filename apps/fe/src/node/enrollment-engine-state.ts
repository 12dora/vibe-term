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
