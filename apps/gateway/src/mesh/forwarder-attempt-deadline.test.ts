import { describe, expect, test } from 'bun:test';
import {
  ForwardDeadlineError,
  armAttemptDeadline,
  waitLinkOrAbort,
} from './forwarder-attempt-deadline';

describe('armAttemptDeadline', () => {
  test('aborts at the budget and dispose clears the timer', async () => {
    const parent = new AbortController();
    const armed = armAttemptDeadline(parent.signal, 30);
    expect(armed.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(armed.signal.aborted).toBe(true);
    expect(armed.signal.reason).toBeInstanceOf(ForwardDeadlineError);
    armed.dispose();
  });

  test('chains the caller abort', () => {
    const parent = new AbortController();
    const armed = armAttemptDeadline(parent.signal, 60_000);
    parent.abort(new Error('caller'));
    expect(armed.signal.aborted).toBe(true);
    armed.dispose();
  });
});

describe('waitLinkOrAbort', () => {
  test('resolves when getLink wins', async () => {
    const parent = new AbortController();
    const link = { id: 'ok' };
    await expect(waitLinkOrAbort(Promise.resolve(link), parent.signal)).resolves.toBe(link);
  });

  test('throws when abort wins against a hanging getLink', async () => {
    const parent = new AbortController();
    const hanging = new Promise<{ id: string }>(() => {});
    const pending = waitLinkOrAbort(hanging, parent.signal);
    parent.abort();
    await expect(pending).rejects.toBeInstanceOf(ForwardDeadlineError);
  });
});
