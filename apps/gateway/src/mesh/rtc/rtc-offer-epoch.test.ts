import { describe, expect, test } from 'bun:test';
import { OfferEpochMemory, RTC_OFFER_EPOCH_TTL_MS } from './rtc-offer-epoch';

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
