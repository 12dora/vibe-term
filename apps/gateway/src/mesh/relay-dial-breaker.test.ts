import { describe, expect, test } from 'bun:test';
import {
  RELAY_DIAL_BREAKER_BASE_MS,
  RELAY_DIAL_BREAKER_FAILS,
  RELAY_RETRYABLE_BACKOFF_MS,
  RelayChooseLogGate,
  RelayDialBreaker,
  classifyRelayDialFailure,
} from './relay-dial-breaker';
import { NodeUnreachableError, PeerHandshakeError } from './types';

const PEER = 'ab'.repeat(16);

describe('classifyRelayDialFailure', () => {
  test('maps handshake timeout, mismatch, rst, open-failed and skip', () => {
    expect(
      classifyRelayDialFailure(new PeerHandshakeError('timeout', 'peer handshake timed out'))
    ).toBe('handshake-timeout');
    expect(classifyRelayDialFailure(new NodeUnreachableError(PEER, 'relay peer id mismatch'))).toBe(
      'peer-id-mismatch'
    );
    expect(classifyRelayDialFailure(new NodeUnreachableError(PEER, 'breaker_cooling'))).toBe(
      'skip'
    );
    expect(classifyRelayDialFailure(new NodeUnreachableError(PEER, 'aborted'))).toBe('skip');
    expect(classifyRelayDialFailure(new NodeUnreachableError(PEER, 'simultaneous-dial'))).toBe(
      'skip'
    );
    expect(classifyRelayDialFailure(new Error('offline'))).toBe('offline');
    expect(classifyRelayDialFailure(new Error('unknown-target'))).toBe('unknown-target');
    expect(classifyRelayDialFailure(new Error('stream rst quota-streams'))).toBe('rst');
    expect(classifyRelayDialFailure(new Error('uplink is not online'))).toBe('open-failed');
  });
});

describe('RelayDialBreaker', () => {
  test('trips after N handshake-timeouts then blocks until cooldown', () => {
    let now = 1_000;
    const trips: number[] = [];
    const breaker = new RelayDialBreaker({
      now: () => now,
      jitter: 0,
      onTrip: (event) => trips.push(event.cooldownMs),
    });
    for (let i = 0; i < RELAY_DIAL_BREAKER_FAILS - 1; i += 1) {
      expect(breaker.noteFailure(PEER, 'handshake-timeout', `a${i}`).opened).toBe(false);
      expect(breaker.shouldTry(PEER).allow).toBe(true);
    }
    const trip = breaker.noteFailure(PEER, 'handshake-timeout', 'a3');
    expect(trip.opened).toBe(true);
    expect(breaker.shouldTry(PEER)).toMatchObject({
      allow: false,
      cooling: true,
      failures: RELAY_DIAL_BREAKER_FAILS,
      level: 1,
      disabled: false,
    });
    expect(trips).toEqual([RELAY_DIAL_BREAKER_BASE_MS]);
    expect(breaker.snapshot(PEER).lastFailureKind).toBe('handshake-timeout');
    now += RELAY_DIAL_BREAKER_BASE_MS - 1;
    expect(breaker.shouldTry(PEER).allow).toBe(false);
    now += 1;
    expect(breaker.shouldTry(PEER).allow).toBe(true);
    expect(breaker.shouldTry(PEER).cooling).toBe(false);
  });

  test('retryable offline uses short backoff and does not trip', () => {
    let now = 5_000;
    const trips: unknown[] = [];
    const breaker = new RelayDialBreaker({
      now: () => now,
      jitter: 0,
      onTrip: (event) => trips.push(event),
    });
    for (let i = 0; i < 8; i += 1) {
      const result = breaker.noteFailure(PEER, 'offline', `o${i}`, now);
      expect(result.opened).toBe(false);
      expect(breaker.shouldTry(PEER, now).allow).toBe(false);
      expect(breaker.snapshot(PEER, now).lastFailureKind).toBe('offline');
      now = (result.until ?? now) + 1;
    }
    expect(trips).toEqual([]);
    expect(breaker.shouldTry(PEER, now).allow).toBe(true);
    expect(breaker.snapshot(PEER, now).level).toBe(0);
    expect(breaker.snapshot(PEER, now).failures).toBe(0);
  });

  test('success clears trip debt immediately', () => {
    const now = 10;
    const breaker = new RelayDialBreaker({ now: () => now, jitter: 0 });
    for (let i = 0; i < RELAY_DIAL_BREAKER_FAILS; i += 1) {
      breaker.noteFailure(PEER, 'open-failed', `f${i}`);
    }
    expect(breaker.shouldTry(PEER).cooling).toBe(true);
    breaker.noteSuccess(PEER);
    expect(breaker.snapshot(PEER)).toMatchObject({
      cooling: false,
      until: null,
      failures: 0,
      level: 0,
      lastFailureKind: null,
      disabled: false,
    });
    expect(breaker.shouldTry(PEER).allow).toBe(true);
  });

  test('singleFlight coalesces concurrent runs onto one promise', async () => {
    const breaker = new RelayDialBreaker({ now: () => 0, jitter: 0 });
    let runs = 0;
    let release!: (value: string) => void;
    const first = breaker.singleFlight(PEER, () => {
      runs += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const rest = Array.from({ length: 9 }, () =>
      breaker.singleFlight(PEER, async () => {
        runs += 1;
        return 'other';
      })
    );
    expect(typeof release).toBe('function');
    release('one');
    expect(await first).toBe('one');
    expect(await Promise.all(rest)).toEqual(Array(9).fill('one'));
    expect(runs).toBe(1);
    expect(await breaker.singleFlight(PEER, async () => 'two')).toBe('two');
  });

  test('singleFlight rejects all waiters with the same error', async () => {
    const breaker = new RelayDialBreaker({ now: () => 0, jitter: 0 });
    const first = breaker.singleFlight(PEER, async () => {
      throw new Error('handshake-timeout');
    });
    const second = breaker.singleFlight(PEER, async () => 'nope');
    await expect(first).rejects.toThrow('handshake-timeout');
    await expect(second).rejects.toThrow('handshake-timeout');
  });

  test('jitter stretches cooldown; random=0.5 is a no-op', () => {
    const now = 1_000;
    const plain = new RelayDialBreaker({ now: () => now, jitter: 0.2, random: () => 0.5 });
    for (let i = 0; i < RELAY_DIAL_BREAKER_FAILS; i += 1) {
      plain.noteFailure(PEER, 'rst', `r${i}`);
    }
    expect(plain.shouldTry(PEER).until).toBe(now + RELAY_DIAL_BREAKER_BASE_MS);

    const stretched = new RelayDialBreaker({ now: () => now, jitter: 0.2, random: () => 1 });
    for (let i = 0; i < RELAY_DIAL_BREAKER_FAILS; i += 1) {
      stretched.noteFailure(PEER, 'rst', `s${i}`);
    }
    expect(stretched.shouldTry(PEER).until).toBe(
      now + Math.round(RELAY_DIAL_BREAKER_BASE_MS * 1.2)
    );
  });

  test('skip kinds do not count', () => {
    const breaker = new RelayDialBreaker({ now: () => 0, jitter: 0 });
    expect(breaker.noteFailure(PEER, 'aborted').counted).toBe(false);
    expect(breaker.noteFailure(PEER, 'breaker_cooling').counted).toBe(false);
    expect(breaker.snapshot(PEER).failures).toBe(0);
  });
});

describe('RelayChooseLogGate', () => {
  test('logs first select and via switch; throttles same via inside the window', () => {
    let now = 0;
    const gate = new RelayChooseLogGate({ now: () => now, intervalMs: 30_000 });
    expect(gate.shouldLog(PEER, 'https://jp.example')).toBe(true);
    expect(gate.shouldLog(PEER, 'https://jp.example')).toBe(false);
    now = 29_999;
    expect(gate.shouldLog(PEER, 'https://jp.example')).toBe(false);
    expect(gate.shouldLog(PEER, 'https://sh.example')).toBe(true);
    now = 29_999 + 30_000;
    expect(gate.shouldLog(PEER, 'https://sh.example')).toBe(true);
  });
});

describe('retryable delay', () => {
  test('first offline waits the short base', () => {
    const now = 0;
    const breaker = new RelayDialBreaker({ now: () => now, jitter: 0 });
    const result = breaker.noteFailure(PEER, 'unknown-target');
    expect(result.until).toBe(RELAY_RETRYABLE_BACKOFF_MS);
  });
});
