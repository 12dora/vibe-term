import { type DeferredSelectCallbacks, DeferredSelectEffects } from './deferred-select-effects';

// FE 选择事务状态机
// 管理 pane 切换、history/live 合并
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

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
}

export type OutputGateState = 'FLOWING' | 'BUFFERING';

export interface OutputGate {
  state: OutputGateState;
  buffer: Uint8Array[];
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

export interface SelectCallbacks extends DeferredSelectCallbacks {
  onSelectFailed?: (deviceId: string, reason: SelectFailureReason) => void;
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
}

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
  private deferred = new DeferredSelectEffects();
  private callbacks: SelectCallbacks;
  private readonly ackTimeoutMs: number;
  private readonly progressTimeoutMs: number;
  private readonly scheduler: SelectTimerScheduler;
  private timers = new Map<string, unknown>();
  private activeTimers = new Map<string, ActiveTimer>();
  private generations = new Map<string, number>();
  private nextTimerToken = 1;

  constructor(callbacks: SelectCallbacks = {}, options: SelectStateMachineOptions = {}) {
    this.callbacks = callbacks;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1500;
    this.progressTimeoutMs = options.progressTimeoutMs ?? 5000;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  setCallbacks(callbacks: SelectCallbacks): void {
    this.callbacks = callbacks;
    for (const deviceId of this.deferred.deviceIds(this.transactions.keys())) {
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
    this.deferred.clear(deviceId);

    // 创建新事务
    const transaction: SelectTransaction = {
      state: 'SELECTING',
      deviceId,
      windowId,
      paneId,
      selectToken: new Uint8Array(selectToken),
      wantHistory,
      startedAt: Date.now(),
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

    this.deferred.historyOrDefer(
      deviceId,
      {
        paneId: transaction.paneId,
        data,
        alternateScreen: event.alternateScreen,
        modes: event.modes,
      },
      this.callbacks
    );

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

    // 清除超时
    this.clearTimer(deviceId);

    // 更新状态
    transaction.state = 'LIVE';

    // 停止输出门控并 flush
    const buffered = this.stopOutputBuffering(deviceId);
    const transactionPaneId = transaction.paneId;

    if (commitWithoutHistory) {
      this.deferred.resetOrDefer(deviceId, transactionPaneId, this.callbacks.onResetTerminal);
    }

    this.completeTransaction(deviceId);
    this.deferred.flushOrDefer(deviceId, transactionPaneId, buffered, this.callbacks.onFlushBuffer);
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
      this.bufferOutput(deviceId, data);
      return;
    }

    this.emitOutput(deviceId, paneId, data);
  }

  private emitOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    this.deferred.outputOrDefer(deviceId, paneId, data, this.callbacks.onOutput);
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
    this.deferred.clear(deviceId);

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
    this.deferred.clear(deviceId);
  }

  // ========== 输出门控 ==========

  private startOutputBuffering(deviceId: string): void {
    this.outputGates.set(deviceId, {
      state: 'BUFFERING',
      buffer: [],
    });
  }

  private stopOutputBuffering(deviceId: string): Uint8Array[] {
    const gate = this.outputGates.get(deviceId);
    if (!gate) return [];

    const buffered = [...gate.buffer];
    this.outputGates.delete(deviceId);
    return buffered;
  }

  private bufferOutput(deviceId: string, data: Uint8Array): void {
    const gate = this.outputGates.get(deviceId);
    if (!gate) return;

    // 限制缓冲大小
    if (gate.buffer.length >= 1000) {
      gate.buffer.shift();
    }

    gate.buffer.push(new Uint8Array(data));
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
    this.deferred.replay(deviceId, this.callbacks);
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

  cleanup(deviceId: string): void {
    this.cancelTransaction(deviceId);
    this.outputGates.delete(deviceId);
    this.deferred.clear(deviceId);
    this.generations.delete(deviceId);
  }

  cleanupAll(): void {
    for (const deviceId of this.transactions.keys()) {
      this.cleanup(deviceId);
    }
    this.transactions.clear();
    this.outputGates.clear();
    this.deferred.clear();
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
