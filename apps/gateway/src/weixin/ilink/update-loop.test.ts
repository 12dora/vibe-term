import { describe, expect, test } from 'bun:test';
import type { WeixinMessage } from './types';
import {
  AbortError,
  WeixinSessionExpiredError,
  computeBackoffMs,
  isAbort,
  isSessionExpired,
  runUpdateLoop,
} from './update-loop';

describe('computeBackoffMs', () => {
  test('doubles from 2s and caps at 30s', () => {
    expect(computeBackoffMs(1)).toBe(2_000);
    expect(computeBackoffMs(2)).toBe(4_000);
    expect(computeBackoffMs(3)).toBe(8_000);
    expect(computeBackoffMs(4)).toBe(16_000);
    expect(computeBackoffMs(5)).toBe(30_000);
    expect(computeBackoffMs(6)).toBe(30_000);
  });
});

describe('isSessionExpired', () => {
  test('detects ret=-14 and errcode=-14', () => {
    expect(isSessionExpired({ ret: -14 })).toBe(true);
    expect(isSessionExpired({ ret: 0, errcode: -14 })).toBe(true);
    expect(isSessionExpired({ ret: 0 })).toBe(false);
  });
});

describe('isAbort', () => {
  test('matches AbortError by instance and by name', () => {
    expect(isAbort(new AbortError())).toBe(true);
    const named = new Error('x');
    named.name = 'AbortError';
    expect(isAbort(named)).toBe(true);
    expect(isAbort(new Error('nope'))).toBe(false);
  });

  test('true when the linked signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error('other'), controller.signal)).toBe(true);
  });
});

describe('runUpdateLoop', () => {
  test('loadCursor failure propagates', async () => {
    await expect(
      runUpdateLoop({
        credentials: { accountId: 'a', botToken: 't', baseUrl: 'https://b.example' },
        signal: new AbortController().signal,
        loadCursor: () => {
          throw new Error('cursor load failed');
        },
        toInbound: (msg) => ({
          fromUserId: msg.from_user_id ?? '',
          contextToken: msg.context_token ?? null,
          text: '',
          raw: msg,
        }),
      })
    ).rejects.toThrow('cursor load failed');
  });

  test('session expiry calls onSessionExpired then throws', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ret: -14, errmsg: 'session timeout' }), {
        status: 200,
      })) as typeof fetch;
    let expired = false;

    await expect(
      runUpdateLoop({
        credentials: { accountId: 'a', botToken: 't', baseUrl: 'https://b.example' },
        signal: new AbortController().signal,
        fetchImpl,
        onSessionExpired: () => {
          expired = true;
        },
        toInbound: (msg: WeixinMessage) => ({
          fromUserId: msg.from_user_id ?? '',
          contextToken: msg.context_token ?? null,
          text: '',
          raw: msg,
        }),
      })
    ).rejects.toBeInstanceOf(WeixinSessionExpiredError);

    expect(expired).toBe(true);
  });
});
