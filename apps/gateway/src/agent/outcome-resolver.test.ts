import { describe, expect, test } from 'bun:test';
import {
  type AgentStopReason,
  PANE_LOST_FALLBACK_MESSAGE,
  type RunOnceDecision,
  type RunOnceSignals,
  resolveRunOnceOutcome,
} from './outcome-resolver';

const BOOLS = [false, true] as const;
const STOP_REASONS: ReadonlyArray<AgentStopReason | null> = [
  null,
  'manual',
  'shutdown',
  'pane_lost',
];

function abortedBranch(signals: RunOnceSignals): RunOnceDecision {
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

/** 测试侧独立描述优先级，避免和生产实现共用一份 if 链。 */
function spec(signals: RunOnceSignals): RunOnceDecision {
  if (signals.stalled) {
    return { kind: 'stalled-error' };
  }
  if (signals.stopReason) {
    return abortedBranch(signals);
  }
  if (signals.steerRequested) {
    return { kind: 'steer' };
  }
  if (signals.aborted) {
    return abortedBranch(signals);
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

function base(overrides: Partial<RunOnceSignals> = {}): RunOnceSignals {
  return {
    stalled: false,
    stopReason: null,
    steerRequested: false,
    aborted: false,
    streamError: null,
    hasApprovals: false,
    hasQueuedMessages: false,
    terminalFatal: false,
    terminalFatalMessage: 'fatal-msg',
    ...overrides,
  };
}

describe('resolveRunOnceOutcome 优先级', () => {
  test('stalled 压过 stop / steer / abort / error / approval / queue', () => {
    expect(
      resolveRunOnceOutcome(
        base({
          stalled: true,
          stopReason: 'manual',
          steerRequested: true,
          aborted: true,
          streamError: new Error('x'),
          hasApprovals: true,
          hasQueuedMessages: true,
          terminalFatal: true,
        })
      )
    ).toEqual({ kind: 'stalled-error' });
  });

  test('stopReason 压过 steer（手动停止优先于队列续跑）', () => {
    expect(resolveRunOnceOutcome(base({ stopReason: 'manual', steerRequested: true }))).toEqual({
      kind: 'stopped',
    });
  });

  test('abort 子优先级：terminalFatal > shutdown > pane_lost > stopped', () => {
    expect(resolveRunOnceOutcome(base({ stopReason: 'shutdown', terminalFatal: true }))).toEqual({
      kind: 'fatal-error',
      message: 'fatal-msg',
    });
    expect(resolveRunOnceOutcome(base({ stopReason: 'shutdown' }))).toEqual({
      kind: 'interrupted',
    });
    expect(resolveRunOnceOutcome(base({ stopReason: 'pane_lost' }))).toEqual({
      kind: 'pane-lost-error',
      message: 'fatal-msg',
    });
    expect(
      resolveRunOnceOutcome(base({ stopReason: 'pane_lost', terminalFatalMessage: '' }))
    ).toEqual({
      kind: 'pane-lost-error',
      message: PANE_LOST_FALLBACK_MESSAGE,
    });
    expect(resolveRunOnceOutcome(base({ stopReason: 'manual' }))).toEqual({ kind: 'stopped' });
  });

  test('steerRequested 压过 aborted（含 terminalFatal）/ streamError / approval / queue', () => {
    expect(
      resolveRunOnceOutcome(
        base({
          steerRequested: true,
          aborted: true,
          terminalFatal: true,
          streamError: new Error('x'),
          hasApprovals: true,
          hasQueuedMessages: true,
        })
      )
    ).toEqual({ kind: 'steer' });
  });

  test('aborted 压过 streamError / approval / queue，并走 abort 子优先级', () => {
    expect(
      resolveRunOnceOutcome(
        base({ aborted: true, streamError: new Error('x'), hasApprovals: true })
      )
    ).toEqual({ kind: 'stopped' });
    expect(resolveRunOnceOutcome(base({ aborted: true, terminalFatal: true }))).toEqual({
      kind: 'fatal-error',
      message: 'fatal-msg',
    });
  });

  test('streamError 压过 approval / queue，以 throw 交给外层重试', () => {
    const error = new Error('upstream');
    expect(
      resolveRunOnceOutcome(
        base({ streamError: error, hasApprovals: true, hasQueuedMessages: true })
      )
    ).toEqual({ kind: 'throw', error });
  });

  test('approval 压过收尾窗口排队消息（waiting 而非 steer）', () => {
    expect(resolveRunOnceOutcome(base({ hasApprovals: true, hasQueuedMessages: true }))).toEqual({
      kind: 'waiting-confirmation',
    });
  });

  test('自然完成时若有排队消息则 steer，否则 idle', () => {
    expect(resolveRunOnceOutcome(base({ hasQueuedMessages: true }))).toEqual({ kind: 'steer' });
    expect(resolveRunOnceOutcome(base())).toEqual({ kind: 'idle' });
  });

  test('笛卡尔积锁定 abort/approval/steer/stalled/error/done 组合优先级', () => {
    const failures: string[] = [];
    let count = 0;
    for (const stalled of BOOLS) {
      for (const stopReason of STOP_REASONS) {
        for (const steerRequested of BOOLS) {
          for (const aborted of BOOLS) {
            for (const hasError of BOOLS) {
              for (const hasApprovals of BOOLS) {
                for (const hasQueuedMessages of BOOLS) {
                  for (const terminalFatal of BOOLS) {
                    const streamError = hasError ? { tag: 'err' } : null;
                    const signals = base({
                      stalled,
                      stopReason,
                      steerRequested,
                      aborted,
                      streamError,
                      hasApprovals,
                      hasQueuedMessages,
                      terminalFatal,
                    });
                    count += 1;
                    const actual = resolveRunOnceOutcome(signals);
                    const expected = spec(signals);
                    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                      failures.push(
                        `${JSON.stringify({
                          stalled,
                          stopReason,
                          steerRequested,
                          aborted,
                          hasError,
                          hasApprovals,
                          hasQueuedMessages,
                          terminalFatal,
                        })} => actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(count).toBe(512);
    expect(failures).toEqual([]);
  });
});
