// FE 选择事务状态机
// 管理 pane 切换、history/live 合并
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

import type { GatewayRebaseReason } from './transport-types';

// ========== 状态定义 ==========

export type SelectTransactionState =
  | 'STABLE'
  | 'SELECTING'
  | 'ACKED'
  | 'HISTORY_APPLIED'
  | 'LIVE'
  | 'SELECT_FAILED';

export interface SelectTransaction {
  state: SelectTransactionState;
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  startedAt: number;
  // 门控缓冲超限被丢弃过：此事务的 live 流已有缺口，画面只能靠 rebase 重建
  outputGapped: boolean;
}

export type OutputGateState = 'FLOWING' | 'BUFFERING';

export interface OutputGate {
  state: OutputGateState;
  buffer: Uint8Array[];
  bufferedBytes: number;
  overflowed: boolean;
}

interface DeferredHistory {
  paneId: string;
  data: string;
  alternateScreen: boolean;
  modes: number;
}

// ========== 事件定义 ==========

export interface SelectStartEvent {
  type: 'SELECT_START';
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
}

export interface SwitchAckEvent {
  type: 'SWITCH_ACK';
  deviceId: string;
  selectToken: Uint8Array;
}

export interface HistoryEvent {
  type: 'HISTORY';
  deviceId: string;
  selectToken: Uint8Array;
  data: string;
  alternateScreen: boolean;
  modes: number;
}

export interface LiveResumeEvent {
  type: 'LIVE_RESUME';
  deviceId: string;
  selectToken: Uint8Array;
}

export interface OutputEvent {
  type: 'OUTPUT';
  deviceId: string;
  paneId: string;
  data: Uint8Array;
}

export interface SelectFailedEvent {
  type: 'SELECT_FAILED';
  deviceId: string;
}

export type SelectEvent =
  | SelectStartEvent
  | SwitchAckEvent
  | HistoryEvent
  | LiveResumeEvent
  | OutputEvent
  | SelectFailedEvent;

// ========== 回调定义 ==========

// history 提交是原子的：reset 与 applyHistory 必须同时可用，
// 只给一半会让 deferred history 永远提交不出去（缓冲的 live 也就永远不回放）
export interface HistoryCallbacks {
  onResetTerminal: (deviceId: string, paneId: string) => void;
  onApplyHistory: (
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ) => void;
}

interface BaseSelectCallbacks {
  onFlushBuffer?: (deviceId: string, paneId: string, buffer: Uint8Array[]) => void;
  onOutput?: (deviceId: string, paneId: string, data: Uint8Array) => void;
  onSelectFailed?: (deviceId: string, reason: SelectFailureReason) => void;
  // 门控缓冲超限后经既有 rebase 通道请求重建（宿主转 paneSinks.dispatchPaneRebase）
  onRebaseRequired?: (deviceId: string, paneId: string, reason: GatewayRebaseReason) => void;
}

type WithoutHistoryCallbacks = {
  onResetTerminal?: undefined;
  onApplyHistory?: undefined;
};

export type SelectCallbacks = BaseSelectCallbacks & (HistoryCallbacks | WithoutHistoryCallbacks);

function resolveHistoryCallbacks(callbacks: SelectCallbacks): HistoryCallbacks | null {
  // 显式标注切断解构后的相关性收窄：JS 侧调用方仍可能传半套，运行时必须自己判
  const onResetTerminal: HistoryCallbacks['onResetTerminal'] | undefined =
    callbacks.onResetTerminal;
  const onApplyHistory: HistoryCallbacks['onApplyHistory'] | undefined = callbacks.onApplyHistory;
  if (onResetTerminal && onApplyHistory) return { onResetTerminal, onApplyHistory };
  if (onResetTerminal || onApplyHistory) {
    throw new Error(
      'SelectCallbacks: onResetTerminal 与 onApplyHistory 必须成对提供（history 提交是原子的）'
    );
  }
  return null;
}

export type SelectFailureReason =
  | 'rejected'
  | 'ack_timeout'
  | 'progress_timeout'
  | 'history_missing';

export interface SelectTimerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface SelectStateMachineOptions {
  ackTimeoutMs?: number;
  progressTimeoutMs?: number;
  scheduler?: SelectTimerScheduler;
  maxBufferedBytes?: number;
}

const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_FRAMES = 1000;

const defaultScheduler: SelectTimerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type SelectTimerPhase = 'ack' | 'progress';

interface ActiveTimer {
  token: number;
  generation: number;
  phase: SelectTimerPhase;
}

// ========== 状态机 ==========

export class SelectStateMachine {
  private transactions = new Map<string, SelectTransaction>();
  private outputGates = new Map<string, OutputGate>();
  private deferredResets = new Map<string, string>();
  private deferredHistories = new Map<string, DeferredHistory>();
  private deferredFlushes = new Map<string, { paneId: string; buffer: Uint8Array[] }>();
  private deferredOutputs = new Map<string, Array<{ paneId: string; data: Uint8Array }>>();
  private pendingRebases = new Map<string, Map<string, GatewayRebaseReason>>();
  private callbacks: SelectCallbacks;
  private historyCallbacks: HistoryCallbacks | null;
  private readonly ackTimeoutMs: number;
  private readonly progressTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly scheduler: SelectTimerScheduler;
  private timers = new Map<string, unknown>();
  private activeTimers = new Map<string, ActiveTimer>();
  private generations = new Map<string, number>();
  private nextTimerToken = 1;

  constructor(callbacks: SelectCallbacks = {}, options: SelectStateMachineOptions = {}) {
    this.historyCallbacks = resolveHistoryCallbacks(callbacks);
    this.callbacks = callbacks;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1500;
    this.progressTimeoutMs = options.progressTimeoutMs ?? 5000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  setCallbacks(callbacks: SelectCallbacks): void {
    this.historyCallbacks = resolveHistoryCallbacks(callbacks);
    this.callbacks = callbacks;
    for (const deviceId of this.transactions.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredResets.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredHistories.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredFlushes.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredOutputs.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.pendingRebases.keys()) {
      this.replayDeferred(deviceId);
    }
  }

  // ========== 状态查询 ==========

  getTransaction(deviceId: string): SelectTransaction | undefined {
    return this.transactions.get(deviceId);
  }

  getState(deviceId: string): SelectTransactionState {
    return this.transactions.get(deviceId)?.state ?? 'STABLE';
  }

  isStable(deviceId: string): boolean {
    return this.getState(deviceId) === 'STABLE';
  }

  isBuffering(deviceId: string): boolean {
    return this.outputGates.get(deviceId)?.state === 'BUFFERING';
  }

  reportTerminalProgress(deviceId?: string): void {
    if (deviceId) {
      const transaction = this.transactions.get(deviceId);
      if (transaction?.state === 'ACKED' || transaction?.state === 'HISTORY_APPLIED') {
        this.armProgressDeadline(deviceId);
      }
      return;
    }
    for (const [currentDeviceId, transaction] of this.transactions) {
      if (transaction.state === 'ACKED' || transaction.state === 'HISTORY_APPLIED') {
        this.armProgressDeadline(currentDeviceId);
      }
    }
  }

  // ========== 事件处理 ==========

  dispatch(event: SelectEvent): void {
    switch (event.type) {
      case 'SELECT_START':
        this.handleSelectStart(event);
        break;
      case 'SWITCH_ACK':
        this.handleSwitchAck(event);
        break;
      case 'HISTORY':
        this.handleHistory(event);
        break;
      case 'LIVE_RESUME':
        this.handleLiveResume(event);
        break;
      case 'OUTPUT':
        this.handleOutput(event);
        break;
      case 'SELECT_FAILED':
        this.handleSelectFailed(event);
        break;
    }
  }

  // ========== 事件处理器 ==========

  private handleSelectStart(event: SelectStartEvent): void {
    const { deviceId, windowId, paneId, selectToken, wantHistory } = event;

    // 取消之前的事务
    this.cancelTransaction(deviceId);
    this.clearDeferred(deviceId);

    // 创建新事务
    const transaction: SelectTransaction = {
      state: 'SELECTING',
      deviceId,
      windowId,
      paneId,
      selectToken: new Uint8Array(selectToken),
      wantHistory,
      startedAt: Date.now(),
      outputGapped: false,
    };

    this.transactions.set(deviceId, transaction);
    const generation = this.nextGeneration(deviceId);

    // 启动输出门控
    this.startOutputBuffering(deviceId);

    // 设置 ACK 超时
    this.setTimer(
      deviceId,
      generation,
      'ack',
      () => {
        this.handleTimeout(deviceId, 'ack');
      },
      this.ackTimeoutMs
    );
  }

  private handleSwitchAck(event: SwitchAckEvent): void {
    const { deviceId, selectToken } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'SELECTING') {
      return;
    }

    // 清除 ACK 超时
    this.clearTimer(deviceId);

    // 更新状态
    transaction.state = 'ACKED';

    // ACK 只证明服务端接受了切换；旧画面要保留到完整 history 或无 history 的 live commit。
    this.armProgressDeadline(deviceId);
  }

  private handleHistory(event: HistoryEvent): void {
    const { deviceId, selectToken, data } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'ACKED') {
      return;
    }

    // 更新状态
    transaction.state = 'HISTORY_APPLIED';

    // 门控缓冲已溢出：画面改由 rebase 快照重建，此处提交 history 只会覆盖掉更新的快照
    if (!transaction.outputGapped) {
      const history = this.historyCallbacks;
      if (history) {
        history.onResetTerminal(deviceId, transaction.paneId);
        history.onApplyHistory(
          deviceId,
          transaction.paneId,
          data,
          event.alternateScreen,
          event.modes
        );
      } else {
        this.deferredHistories.set(deviceId, {
          paneId: transaction.paneId,
          data,
          alternateScreen: event.alternateScreen,
          modes: event.modes,
        });
      }
    }

    this.armProgressDeadline(deviceId);
  }

  private handleLiveResume(event: LiveResumeEvent): void {
    const { deviceId, selectToken } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'ACKED' && transaction.state !== 'HISTORY_APPLIED') {
      return;
    }

    if (transaction.state === 'ACKED' && transaction.wantHistory) {
      this.failTransaction(deviceId, 'history_missing');
      return;
    }

    const commitWithoutHistory = transaction.state === 'ACKED';
    const outputGapped = transaction.outputGapped;

    // 清除超时
    this.clearTimer(deviceId);

    // 更新状态
    transaction.state = 'LIVE';

    // 停止输出门控并 flush
    const buffered = this.stopOutputBuffering(deviceId);
    const transactionPaneId = transaction.paneId;

    // 缓冲已被溢出丢弃：不 reset、不回放残缺缓冲，画面由 rebase 快照重建
    if (outputGapped) {
      this.completeTransaction(deviceId);
      this.replayDeferred(deviceId);
      return;
    }

    if (commitWithoutHistory) {
      if (this.historyCallbacks) {
        this.historyCallbacks.onResetTerminal(deviceId, transactionPaneId);
      } else {
        this.deferredResets.set(deviceId, transactionPaneId);
      }
    }

    // 完成事务
    this.completeTransaction(deviceId);

    const replacementDeferred =
      this.deferredResets.has(deviceId) || this.deferredHistories.has(deviceId);
    if (this.callbacks.onFlushBuffer && !replacementDeferred) {
      this.callbacks.onFlushBuffer(deviceId, transactionPaneId, buffered);
    } else if (buffered.length > 0) {
      this.deferredFlushes.set(deviceId, { paneId: transactionPaneId, buffer: buffered });
    }

    this.replayDeferred(deviceId);
  }

  private handleOutput(event: OutputEvent): void {
    const { deviceId, paneId, data } = event;
    const transaction = this.transactions.get(deviceId);

    // 非事务 pane 的输出（分屏兄弟 pane）直接路由，不参与切换门控
    if (transaction && transaction.paneId !== paneId) {
      this.emitOutput(deviceId, paneId, data);
      return;
    }

    // 如果在缓冲状态，缓冲输出
    if (this.isBuffering(deviceId)) {
      if (transaction?.state === 'ACKED' || transaction?.state === 'HISTORY_APPLIED') {
        this.armProgressDeadline(deviceId);
      }
      this.bufferOutput(deviceId, paneId, data);
      return;
    }

    this.emitOutput(deviceId, paneId, data);
  }

  private emitOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    if (this.callbacks.onOutput) {
      this.callbacks.onOutput(deviceId, paneId, data);
      return;
    }

    const pending = this.deferredOutputs.get(deviceId) ?? [];
    pending.push({ paneId, data });
    this.deferredOutputs.set(deviceId, pending);
  }

  private handleSelectFailed(event: SelectFailedEvent): void {
    const { deviceId } = event;
    this.failTransaction(deviceId, 'rejected');
  }

  private handleTimeout(deviceId: string, stage: 'ack' | 'history' | 'live'): void {
    console.warn(`[select-sm] Timeout at ${stage} for ${deviceId}`);
    this.failTransaction(deviceId, stage === 'ack' ? 'ack_timeout' : 'progress_timeout');
  }

  // ========== 事务管理 ==========

  private completeTransaction(deviceId: string): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    transaction.state = 'STABLE';
    this.transactions.delete(deviceId);
    this.clearTimer(deviceId);
  }

  private failTransaction(deviceId: string, reason: SelectFailureReason): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    transaction.state = 'SELECT_FAILED';

    // 停止输出门控
    this.stopOutputBuffering(deviceId);

    // 清理
    this.transactions.delete(deviceId);
    this.clearTimer(deviceId);
    this.clearDeferred(deviceId);

    this.callbacks.onSelectFailed?.(deviceId, reason);
  }

  private cancelTransaction(deviceId: string): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    // 丢弃缓冲的输出
    this.stopOutputBuffering(deviceId);

    // 清理
    this.transactions.delete(deviceId);
    this.clearTimer(deviceId);
    this.clearDeferred(deviceId);
  }

  // ========== 输出门控 ==========

  private startOutputBuffering(deviceId: string): void {
    this.outputGates.set(deviceId, {
      state: 'BUFFERING',
      buffer: [],
      bufferedBytes: 0,
      overflowed: false,
    });
  }

  private stopOutputBuffering(deviceId: string): Uint8Array[] {
    const gate = this.outputGates.get(deviceId);
    if (!gate) return [];

    this.outputGates.delete(deviceId);
    return gate.buffer;
  }

  private bufferOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const gate = this.outputGates.get(deviceId);
    if (!gate || gate.overflowed) return;

    if (
      gate.buffer.length >= MAX_BUFFERED_FRAMES ||
      gate.bufferedBytes + data.byteLength > this.maxBufferedBytes
    ) {
      this.overflowOutputGate(deviceId, paneId, gate);
      return;
    }

    // 帧字节由单次 WS 消息的解码结果独占，解码器不复用底层 buffer，无需拷贝
    gate.buffer.push(data);
    gate.bufferedBytes += data.byteLength;
  }

  // 缓冲超限：丢弃已缓冲的字节（此后不再缓冲），标记事务并沿既有 rebase 通道请求重建画面。
  // 缺口不能靠截断缓冲蒙混过去——少写一段字节等价于把终端状态机喂到未定义状态。
  private overflowOutputGate(deviceId: string, paneId: string, gate: OutputGate): void {
    gate.buffer = [];
    gate.bufferedBytes = 0;
    gate.overflowed = true;

    const transaction = this.transactions.get(deviceId);
    if (transaction) transaction.outputGapped = true;

    console.warn(`[select-sm] output buffer overflow on ${deviceId}:${paneId}, requesting rebase`);
    this.requestRebase(deviceId, paneId, 'resource_exhausted');
  }

  // 宿主可能尚未注册回调（setCallbacks 晚到）：先按 pane 记账，回调补齐后立即补发，
  // 否则这次缺口永远拿不到重建请求
  private requestRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const onRebaseRequired = this.callbacks.onRebaseRequired;
    if (onRebaseRequired) {
      onRebaseRequired(deviceId, paneId, reason);
      return;
    }
    const pending = this.pendingRebases.get(deviceId) ?? new Map<string, GatewayRebaseReason>();
    pending.set(paneId, reason);
    this.pendingRebases.set(deviceId, pending);
  }

  private flushPendingRebases(deviceId: string): void {
    const onRebaseRequired = this.callbacks.onRebaseRequired;
    if (!onRebaseRequired) return;
    const pending = this.pendingRebases.get(deviceId);
    if (!pending) return;
    this.pendingRebases.delete(deviceId);
    for (const [paneId, reason] of pending) {
      onRebaseRequired(deviceId, paneId, reason);
    }
  }

  // ========== 工具方法 ==========

  private validateToken(expected: Uint8Array, received: Uint8Array): boolean {
    if (expected.length !== received.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== received[i]) return false;
    }
    return true;
  }

  private replayDeferred(deviceId: string): void {
    this.flushPendingRebases(deviceId);

    const historyCallbacks = this.historyCallbacks;
    const resetPaneId = this.deferredResets.get(deviceId);
    if (resetPaneId !== undefined && historyCallbacks) {
      this.deferredResets.delete(deviceId);
      historyCallbacks.onResetTerminal(deviceId, resetPaneId);
    }

    const history = this.deferredHistories.get(deviceId);
    if (history !== undefined && historyCallbacks) {
      historyCallbacks.onResetTerminal(deviceId, history.paneId);
      historyCallbacks.onApplyHistory(
        deviceId,
        history.paneId,
        history.data,
        history.alternateScreen,
        history.modes
      );
      this.deferredHistories.delete(deviceId);
    }

    if (this.deferredResets.has(deviceId) || this.deferredHistories.has(deviceId)) {
      return;
    }

    const flush = this.deferredFlushes.get(deviceId);
    if (flush && this.callbacks.onFlushBuffer) {
      this.callbacks.onFlushBuffer(deviceId, flush.paneId, flush.buffer);
      this.deferredFlushes.delete(deviceId);
    }

    const outputs = this.deferredOutputs.get(deviceId);
    if (outputs && this.callbacks.onOutput) {
      for (const output of outputs) {
        this.callbacks.onOutput(deviceId, output.paneId, output.data);
      }
      this.deferredOutputs.delete(deviceId);
    }
  }

  private clearDeferred(deviceId: string): void {
    this.deferredResets.delete(deviceId);
    this.deferredHistories.delete(deviceId);
    this.deferredFlushes.delete(deviceId);
    this.deferredOutputs.delete(deviceId);
  }

  private nextGeneration(deviceId: string): number {
    const generation = (this.generations.get(deviceId) ?? 0) + 1;
    this.generations.set(deviceId, generation);
    return generation;
  }

  private setTimer(
    deviceId: string,
    generation: number,
    phase: SelectTimerPhase,
    callback: () => void,
    delay: number
  ): void {
    this.clearTimer(deviceId);
    const token = this.nextTimerToken++;
    const handle = this.scheduler.schedule(() => {
      if (!this.isTimerCurrent(deviceId, token, generation, phase)) return;
      this.timers.delete(deviceId);
      this.activeTimers.delete(deviceId);
      callback();
    }, delay);
    this.timers.set(deviceId, handle);
    this.activeTimers.set(deviceId, { token, generation, phase });
  }

  private isTimerCurrent(
    deviceId: string,
    token: number,
    generation: number,
    phase: SelectTimerPhase
  ): boolean {
    if (this.generations.get(deviceId) !== generation) return false;
    if (!this.transactions.has(deviceId)) return false;
    const active = this.activeTimers.get(deviceId);
    return (
      active !== undefined &&
      active.token === token &&
      active.generation === generation &&
      active.phase === phase
    );
  }

  private armProgressDeadline(deviceId: string): void {
    const generation = this.generations.get(deviceId);
    if (generation === undefined) return;
    this.setTimer(
      deviceId,
      generation,
      'progress',
      () => {
        this.handleTimeout(deviceId, 'live');
      },
      this.progressTimeoutMs
    );
  }

  private clearTimer(deviceId: string): void {
    const timer = this.timers.get(deviceId);
    if (timer !== undefined) {
      this.scheduler.cancel(timer);
      this.timers.delete(deviceId);
    }
    this.activeTimers.delete(deviceId);
  }

  // ========== 清理 ==========

  /**
   * 目标 pane 已从快照中消失（被 kill / 关闭）：丢弃针对它的事务与门控缓冲。
   * 不走 failTransaction——失败回调会触发调用方的重选重试，对着死 pane 空转。
   */
  abandonPane(deviceId: string, paneId: string): boolean {
    const transaction = this.transactions.get(deviceId);
    if (!transaction || transaction.paneId !== paneId) return false;
    this.cancelTransaction(deviceId);
    return true;
  }

  cleanup(deviceId: string): void {
    this.cancelTransaction(deviceId);
    this.outputGates.delete(deviceId);
    this.clearDeferred(deviceId);
    this.pendingRebases.delete(deviceId);
    this.generations.delete(deviceId);
  }

  cleanupAll(): void {
    for (const deviceId of this.transactions.keys()) {
      this.cleanup(deviceId);
    }
    this.transactions.clear();
    this.outputGates.clear();
    this.deferredResets.clear();
    this.deferredHistories.clear();
    this.deferredFlushes.clear();
    this.deferredOutputs.clear();
    this.pendingRebases.clear();
    for (const timer of this.timers.values()) {
      this.scheduler.cancel(timer);
    }
    this.timers.clear();
    this.activeTimers.clear();
    this.generations.clear();
  }
}

// 全局状态机实例
let globalStateMachine: SelectStateMachine | null = null;

export function getSelectStateMachine(callbacks?: SelectCallbacks): SelectStateMachine {
  if (!globalStateMachine) {
    globalStateMachine = new SelectStateMachine(callbacks);
    return globalStateMachine;
  }
  if (callbacks) {
    globalStateMachine.setCallbacks(callbacks);
  }
  return globalStateMachine;
}
