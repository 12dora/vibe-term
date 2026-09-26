import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { installFinishedDc } from './peer-dialer-dc-finish';
import { takeSessionRtcUnsub } from './session-binding';

function session(): LinkSession {
  return { closed: new Promise(() => {}) } as LinkSession;
}

describe('installFinishedDc signalling subscription', () => {
  test('kept session holds the subscription', () => {
    const dc = session();
    let attached = false;
    let released = false;
    const unsub = () => {
      released = true;
    };
    const kept = installFinishedDc({
      track: () => dc,
      release: (fn) => fn?.(),
      attach: (fn) => {
        attached = fn === unsub;
      },
      gen: 1,
      unsub,
      result: { peerNodeId: 'aa'.repeat(16) },
      attemptId: 'dc:1',
      session: dc,
      initiatedBy: 'bb'.repeat(16),
      remoteAddress: null,
    });
    expect(kept).toBe(dc);
    expect(attached).toBe(true);
    expect(released).toBe(false);
  });

  test('dropped session releases the subscription', () => {
    const dc = session();
    let released = false;
    const kept = installFinishedDc({
      track: () => null,
      release: (fn) => {
        fn?.();
        released = true;
      },
      attach: () => {},
      gen: 1,
      unsub: () => {},
      result: { peerNodeId: 'aa'.repeat(16) },
      attemptId: 'dc:1',
      session: dc,
      initiatedBy: 'bb'.repeat(16),
      remoteAddress: null,
    });
    expect(kept).toBeNull();
    expect(released).toBe(true);
  });

  test('held reroll stashes the subscription until accept', () => {
    const dc = session();
    const unsub = () => {};
    const kept = installFinishedDc({
      reroll: true,
      offer: () => 'held',
      liveSession: () => null,
      track: () => null,
      release: () => {},
      attach: () => {},
      gen: 1,
      unsub,
      result: { peerNodeId: 'aa'.repeat(16) },
      attemptId: 'dc:1',
      session: dc,
      initiatedBy: 'bb'.repeat(16),
      remoteAddress: null,
    });
    expect(kept).toBeNull();
    expect(takeSessionRtcUnsub(dc)).toBe(unsub);
  });

  test('installed reroll attaches the subscription', () => {
    const dc = session();
    let attached = false;
    const unsub = () => {};
    const kept = installFinishedDc({
      reroll: true,
      offer: () => 'installed',
      liveSession: () => dc,
      track: () => {
        throw new Error('installed reroll must not track');
      },
      release: () => {},
      attach: (fn) => {
        attached = fn === unsub;
      },
      gen: 1,
      unsub,
      result: { peerNodeId: 'aa'.repeat(16) },
      attemptId: 'dc:1',
      session: dc,
      initiatedBy: 'bb'.repeat(16),
      remoteAddress: null,
    });
    expect(kept).toBe(dc);
    expect(attached).toBe(true);
  });

  test('rejected reroll releases the subscription', () => {
    const dc = session();
    let released = false;
    const kept = installFinishedDc({
      reroll: true,
      offer: () => 'rejected',
      liveSession: () => null,
      track: () => dc,
      release: (fn) => {
        fn?.();
        released = true;
      },
      attach: () => {},
      gen: 1,
      unsub: () => {},
      result: { peerNodeId: 'aa'.repeat(16) },
      attemptId: 'dc:1',
      session: dc,
      initiatedBy: 'bb'.repeat(16),
      remoteAddress: null,
    });
    expect(kept).toBeNull();
    expect(released).toBe(true);
  });
});
