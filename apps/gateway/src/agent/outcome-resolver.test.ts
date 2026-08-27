import { describe, expect, test } from 'bun:test';
import {
  PANE_LOST_FALLBACK_MESSAGE,
  type RunOnceSignals,
  resolveRunOnceOutcome,
} from './outcome-resolver';

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
});
