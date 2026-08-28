import { describe, expect, test } from 'bun:test';
import {
  ChannelLiveness,
  DEFAULT_RTC_LIVENESS_INTERVAL_MS,
  DEFAULT_RTC_LIVENESS_TIMEOUT_MS,
  LIVENESS_FRAME_ID,
  RTC_LIVENESS_INTERVAL_MS,
  RTC_LIVENESS_TIMEOUT_MS,
  encodeLivenessChunk,
  parseLivenessChunk,
  readRtcLivenessConfig,
} from './liveness';
import { FakeClock } from './test-fakes';

describe('liveness protocol', () => {
  test('encodes ping/pong as frameId 0 single fragments', () => {
    const ping = encodeLivenessChunk('ping');
    const pong = encodeLivenessChunk('pong');
    expect(parseLivenessChunk(ping)).toBe('ping');
    expect(parseLivenessChunk(pong)).toBe('pong');
    expect(ping[0]).toBe(LIVENESS_FRAME_ID);
    expect(parseLivenessChunk(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseLivenessChunk(new Uint8Array(8).fill(0))).toBeNull();
  });

  test('readRtcLivenessConfig reads env overrides and rejects non-positive values', () => {
    const prevInterval = process.env.RTC_LIVENESS_INTERVAL_MS;
    const prevTimeout = process.env.RTC_LIVENESS_TIMEOUT_MS;
    try {
      process.env.RTC_LIVENESS_INTERVAL_MS = undefined;
      process.env.RTC_LIVENESS_TIMEOUT_MS = undefined;
      expect(readRtcLivenessConfig()).toEqual({
        intervalMs: DEFAULT_RTC_LIVENESS_INTERVAL_MS,
        timeoutMs: DEFAULT_RTC_LIVENESS_TIMEOUT_MS,
      });
      expect(RTC_LIVENESS_INTERVAL_MS).toBe(DEFAULT_RTC_LIVENESS_INTERVAL_MS);
      expect(RTC_LIVENESS_TIMEOUT_MS).toBe(DEFAULT_RTC_LIVENESS_TIMEOUT_MS);

      process.env.RTC_LIVENESS_INTERVAL_MS = '1500';
      process.env.RTC_LIVENESS_TIMEOUT_MS = '8000';
      expect(readRtcLivenessConfig()).toEqual({ intervalMs: 1500, timeoutMs: 8000 });

      process.env.RTC_LIVENESS_INTERVAL_MS = '0';
      process.env.RTC_LIVENESS_TIMEOUT_MS = '-4';
      expect(readRtcLivenessConfig()).toEqual({
        intervalMs: DEFAULT_RTC_LIVENESS_INTERVAL_MS,
        timeoutMs: DEFAULT_RTC_LIVENESS_TIMEOUT_MS,
      });
    } finally {
      process.env.RTC_LIVENESS_INTERVAL_MS = prevInterval;
      process.env.RTC_LIVENESS_TIMEOUT_MS = prevTimeout;
    }
  });
});

describe('ChannelLiveness', () => {
  test('sends ping only while idle and times out without inbound', () => {
    const clock = new FakeClock();
    let pings = 0;
    let timedOut = 0;
    const liveness = new ChannelLiveness({
      peer: 'aa',
      intervalMs: 30,
      timeoutMs: 100,
      now: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      sendPing: () => {
        pings += 1;
      },
      onTimeout: (idleMs) => {
        timedOut = idleMs;
      },
    });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      liveness.start();
      clock.advance(29);
      expect(pings).toBe(0);
      clock.advance(1);
      expect(pings).toBe(1);
      liveness.noteInbound();
      clock.advance(29);
      expect(pings).toBe(1);
      clock.advance(1);
      expect(pings).toBe(2);
      clock.advance(70);
      expect(timedOut).toBe(100);
      expect(lines.some((line) => line.includes('[mesh][rtc] liveness timeout'))).toBe(true);
      expect(lines.some((line) => line.includes('peer=aa') && line.includes('idle_ms=100'))).toBe(
        true
      );
    } finally {
      console.log = orig;
      liveness.stop();
    }
  });

  test('stop prevents a later timeout', () => {
    const clock = new FakeClock();
    let timedOut = false;
    const liveness = new ChannelLiveness({
      intervalMs: 10,
      timeoutMs: 20,
      now: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      sendPing: () => {},
      onTimeout: () => {
        timedOut = true;
      },
    });
    liveness.start();
    liveness.stop();
    clock.advance(50);
    expect(timedOut).toBe(false);
  });
});
