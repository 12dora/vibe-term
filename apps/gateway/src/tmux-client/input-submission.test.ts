import { describe, expect, test } from 'bun:test';
import { InputCommandWindow } from './input-command-window';
import { InputSubmission } from './input-submission';
import { PaneInputPacer } from './pane-input-pacer';
import { TestClock } from './pane-input-test-helpers';

const encode = (text: string) => new TextEncoder().encode(text);

describe('InputSubmission', () => {
  test('cancel refuses once submitted, cancelQueued still notifies listeners', () => {
    const submission = new InputSubmission(() => true);
    const calls: string[] = [];
    submission.onCancel(() => calls.push('cancel'));
    submission.submitted = true;
    expect(submission.cancel()).toBe(false);
    expect(calls).toEqual([]);
    submission.cancelQueued();
    submission.cancelQueued();
    expect(calls).toEqual(['cancel']);
    expect(submission.isValid()).toBe(false);
  });

  test('cancelQueued removes still-waiting window jobs of a submitted submission', async () => {
    const window = new InputCommandWindow(() => 1);
    const executed: string[] = [];
    const releases: Array<() => void> = [];
    const execute = (argv: string[]) => {
      executed.push(argv[0]);
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    const submission = new InputSubmission(() => true);
    const first = window.enqueue([['first']], execute, submission);
    submission.submitted = true;
    const waiting = window.enqueue([['waiting']], execute, submission);
    expect(window.pendingByteCount).toBeGreaterThan(0);
    submission.cancelQueued();
    expect(window.pendingByteCount).toBe(0);
    await waiting;
    releases.shift()?.();
    await first;
    expect(executed).toEqual(['first']);
    window.dispose('done');
  });
});

describe('PaneInputPacer.dropPane', () => {
  test('cancels queued commands of a shared keyboard submission already submitted', () => {
    const clock = new TestClock();
    const submissions: InputSubmission[] = [];
    const cancelled: number[] = [];
    const pacer = new PaneInputPacer((_pane, _bytes, _onAck, submission) => {
      submission.submitted = true;
      const index = submissions.push(submission) - 1;
      submission.onCancel(() => cancelled.push(index));
      return new Promise<void>(() => {});
    }, clock);
    void pacer.sendInputBytes('%1', encode('a')).catch(() => {});
    void pacer.sendInputBytes('%1', encode('b')).catch(() => {});
    expect(submissions[0]).toBe(submissions[1]);
    pacer.dropPane('%1');
    expect(cancelled.sort()).toEqual([0, 1]);
  });
});
