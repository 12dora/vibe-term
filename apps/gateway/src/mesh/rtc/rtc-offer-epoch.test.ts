import { describe, expect, test } from 'bun:test';
import {
  OfferEpochMemory,
  RTC_EPOCH_PER_SECOND,
  RTC_OFFER_EPOCH_TTL_MS,
  rtcAttemptEpochBase,
} from './rtc-offer-epoch';

describe('OfferEpochMemory', () => {
  test('keeps the highest epoch inside the window', () => {
    const clock = { ms: 1_000 };
    const memory = new OfferEpochMemory(() => clock.ms);
    memory.remember('peer', 3);
    memory.remember('peer', 7);
    memory.remember('peer', 5);
    expect(memory.get('peer')).toBe(7);
  });

  test('forgets the epoch after the ttl so a restarted offerer is accepted again', () => {
    const clock = { ms: 1_000 };
    const memory = new OfferEpochMemory(() => clock.ms);
    memory.remember('peer', 42);
    clock.ms += RTC_OFFER_EPOCH_TTL_MS;
    expect(memory.get('peer')).toBe(42);
    clock.ms += 1;
    expect(memory.get('peer')).toBeUndefined();
    memory.remember('peer', 1);
    expect(memory.get('peer')).toBe(1);
  });

  test('a lower epoch does not extend the window of the remembered one', () => {
    const clock = { ms: 1_000 };
    const memory = new OfferEpochMemory(() => clock.ms);
    memory.remember('peer', 42);
    clock.ms += RTC_OFFER_EPOCH_TTL_MS - 1;
    memory.remember('peer', 1);
    expect(memory.get('peer')).toBe(42);
    clock.ms += 2;
    expect(memory.get('peer')).toBeUndefined();
  });

  test('undefined epochs and clear() are no-ops on the memory', () => {
    const memory = new OfferEpochMemory(() => 0);
    memory.remember('peer', undefined);
    expect(memory.get('peer')).toBeUndefined();
    memory.remember('peer', 4);
    memory.clear();
    expect(memory.get('peer')).toBeUndefined();
  });
});

describe('rtcAttemptEpochBase', () => {
  test('a restart always allocates epochs above the previous process', () => {
    const started = 1_800_000_000_000;
    const before = rtcAttemptEpochBase(started);
    // 旧进程跑了 10 分钟、拨了 500 次
    const lastOfOldProcess = before + 500;
    const after = rtcAttemptEpochBase(started + 600_000);
    expect(after).toBeGreaterThan(lastOfOldProcess);
    expect(after + 1).toBeGreaterThan(lastOfOldProcess);
  });

  test('one second of uptime outruns a full second of dials', () => {
    const base = rtcAttemptEpochBase(1_800_000_000_000);
    expect(rtcAttemptEpochBase(1_800_000_001_000)).toBe(base + RTC_EPOCH_PER_SECOND);
  });

  test('stays a safe integer well past 2100 and never goes negative', () => {
    expect(Number.isSafeInteger(rtcAttemptEpochBase(4_200_000_000_000))).toBe(true);
    expect(rtcAttemptEpochBase(-5)).toBe(0);
  });
});
