export type AgentStopReason = 'manual' | 'shutdown' | 'pane_lost';

export interface RunOnceSignals {
  stalled: boolean;
  stopReason: AgentStopReason | null;
  steerRequested: boolean;
  aborted: boolean;
  streamError: unknown;
  hasApprovals: boolean;
  hasQueuedMessages: boolean;
  terminalFatal: boolean;
  terminalFatalMessage: string;
}

export type RunOnceDecision =
  | { kind: 'stalled-error' }
  | { kind: 'fatal-error'; message: string }
  | { kind: 'pane-lost-error'; message: string }
  | { kind: 'interrupted' }
  | { kind: 'stopped' }
  | { kind: 'steer' }
  | { kind: 'throw'; error: unknown }
  | { kind: 'waiting-confirmation' }
  | { kind: 'idle' };

export const PANE_LOST_FALLBACK_MESSAGE = 'terminal connection lost: pane/device unavailable';

function resolveAborted(signals: RunOnceSignals): RunOnceDecision {
  if (signals.terminalFatal) {
    return { kind: 'fatal-error', message: signals.terminalFatalMessage };
  }
  if (signals.stopReason === 'shutdown') {
    return { kind: 'interrupted' };
  }
  if (signals.stopReason === 'pane_lost') {
    return {
      kind: 'pane-lost-error',
      message: signals.terminalFatalMessage || PANE_LOST_FALLBACK_MESSAGE,
    };
  }
  return { kind: 'stopped' };
}

/**
 * runOnce 流结束后的收尾优先级（高 → 低）：
 * stalled → stopReason（走 abort 子优先级）→ steerRequested → aborted
 * → streamError → approvals → 收尾窗口排队消息 → idle。
 * abort 子优先级：terminalFatal → shutdown → pane_lost → stopped。
 */
export function resolveRunOnceOutcome(signals: RunOnceSignals): RunOnceDecision {
  if (signals.stalled) {
    return { kind: 'stalled-error' };
  }
  if (signals.stopReason) {
    return resolveAborted(signals);
  }
  if (signals.steerRequested) {
    return { kind: 'steer' };
  }
  if (signals.aborted) {
    return resolveAborted(signals);
  }
  if (signals.streamError) {
    return { kind: 'throw', error: signals.streamError };
  }
  if (signals.hasApprovals) {
    return { kind: 'waiting-confirmation' };
  }
  if (signals.hasQueuedMessages) {
    return { kind: 'steer' };
  }
  return { kind: 'idle' };
}
