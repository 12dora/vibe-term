import { describe, expect, test } from 'bun:test';
import {
  RTC_DIAL_BREAKER_FAILS,
  RTC_DIAL_BREAKER_MS_DEFAULT,
  RtcDialBreaker,
} from './rtc-dial-breaker';

describe('RtcDialBreaker', () => {
  test('opens after 8 consecutive DataChannel failures and skips until expiry', () => {
    const logs: Array<{ peer: string; fails: number; until: number }> = [];
    const breaker = new RtcDialBreaker({
      now: () => 1_000,
      breakerMs: 6 * 60 * 60 * 1000,
      onOpen: (event) => logs.push(event),
    });
    const peer = 'ec42f3';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS - 1; i += 1) {
      expect(breaker.noteFailure(peer)).toEqual({ opened: false, open: false });
      expect(breaker.shouldSkip(peer)).toBe(false);
    }
    const opened = breaker.noteFailure(peer);
    expect(opened).toEqual({
      opened: true,
      open: true,
      until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT,
    });
    expect(breaker.shouldSkip(peer)).toBe(true);
    expect(logs).toEqual([
      { peer, fails: RTC_DIAL_BREAKER_FAILS, until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT },
    ]);
    expect(breaker.noteFailure(peer)).toEqual({
      opened: false,
      open: true,
      until: 1_000 + RTC_DIAL_BREAKER_MS_DEFAULT,
    });
    expect(logs).toHaveLength(1);
  });

  test('resets on success or advertised endpoint/capability change', () => {
    let now = 10;
    const breaker = new RtcDialBreaker({ now: () => now, breakerMs: 60_000 });
    const peer = 'hub-a';
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    expect(breaker.shouldSkip(peer)).toBe(true);
    breaker.noteSuccess(peer);
    expect(breaker.shouldSkip(peer)).toBe(false);

    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    expect(breaker.shouldSkip(peer)).toBe(true);
    breaker.notePeerChanged(peer);
    expect(breaker.shouldSkip(peer)).toBe(false);

    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure(peer);
    now = 10 + 60_000;
    expect(breaker.shouldSkip(peer)).toBe(false);
  });

  test('does not skip ws-secure peers: skip is per-peer DataChannel only', () => {
    const breaker = new RtcDialBreaker({ now: () => 0 });
    for (let i = 0; i < RTC_DIAL_BREAKER_FAILS; i += 1) breaker.noteFailure('a');
    expect(breaker.shouldSkip('a')).toBe(true);
    expect(breaker.shouldSkip('b')).toBe(false);
  });
});
