import { describe, expect, test } from 'bun:test';
import {
  ANSWERER_COOLDOWN_MS,
  ANSWERER_TIMEOUT_LIMIT,
  AnswererOfferBackoff,
} from './rtc-answerer-backoff';

describe('AnswererOfferBackoff', () => {
  test('3 次连续超时后忽略 offer，冷却 30s → 2min → 10min，成功后复位', () => {
    let now = 1_000;
    const backoff = new AnswererOfferBackoff(() => now);
    const peer = 'ec42f364';
    expect(backoff.shouldAccept(peer)).toBe(true);
    expect(backoff.noteTimeout(peer).opened).toBe(false);
    expect(backoff.noteTimeout(peer).opened).toBe(false);
    const trip = backoff.noteTimeout(peer);
    expect(trip).toMatchObject({
      opened: true,
      cooldownMs: ANSWERER_COOLDOWN_MS[0],
      consecutive: ANSWERER_TIMEOUT_LIMIT,
    });
    expect(backoff.shouldAccept(peer)).toBe(false);
    expect(backoff.noteTimeout(peer).opened).toBe(false);

    now += ANSWERER_COOLDOWN_MS[0] - 1;
    expect(backoff.shouldAccept(peer)).toBe(false);
    now += 1;
    expect(backoff.shouldAccept(peer)).toBe(true);

    backoff.noteTimeout(peer);
    backoff.noteTimeout(peer);
    const second = backoff.noteTimeout(peer);
    expect(second.opened).toBe(true);
    expect(second.cooldownMs).toBe(ANSWERER_COOLDOWN_MS[1]);
    expect(backoff.shouldAccept(peer)).toBe(false);

    now += ANSWERER_COOLDOWN_MS[1];
    backoff.noteTimeout(peer);
    backoff.noteTimeout(peer);
    expect(backoff.noteTimeout(peer).cooldownMs).toBe(ANSWERER_COOLDOWN_MS[2]);

    now += ANSWERER_COOLDOWN_MS[2];
    backoff.noteTimeout(peer);
    backoff.noteTimeout(peer);
    expect(backoff.noteTimeout(peer).cooldownMs).toBe(ANSWERER_COOLDOWN_MS[2]);

    backoff.noteSuccess(peer);
    expect(backoff.shouldAccept(peer)).toBe(true);
    expect(backoff.noteTimeout(peer).opened).toBe(false);
    expect(backoff.noteTimeout(peer).opened).toBe(false);
    expect(backoff.noteTimeout(peer).cooldownMs).toBe(ANSWERER_COOLDOWN_MS[0]);
  });

  test('reset 清掉冷却；不同对端互不影响', () => {
    const backoff = new AnswererOfferBackoff(() => 0);
    for (let i = 0; i < ANSWERER_TIMEOUT_LIMIT; i += 1) backoff.noteTimeout('a');
    expect(backoff.shouldAccept('a')).toBe(false);
    expect(backoff.shouldAccept('b')).toBe(true);
    backoff.reset('a');
    expect(backoff.shouldAccept('a')).toBe(true);
  });
});
