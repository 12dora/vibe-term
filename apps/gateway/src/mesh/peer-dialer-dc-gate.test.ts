import { describe, expect, test } from 'bun:test';
import { gateDcDial, noteDialDcFailure, planInboundOffer } from './peer-dialer-dc-gate';
import type { RtcDialBreakerDecision } from './rtc/rtc-dial-breaker';
import { DcDeclinedError, offererReactionToRemoteSdp } from './rtc/rtc-offer-decline';

function decision(
  patch: Partial<RtcDialBreakerDecision> & Pick<RtcDialBreakerDecision, 'level' | 'disabled'>
): RtcDialBreakerDecision {
  return {
    allow: false,
    cooling: true,
    until: 99_000,
    failures: 12,
    ...patch,
  };
}

describe('gateDcDial inbound offers', () => {
  test('low-level cooling still answers a peer-initiated offer', () => {
    const allowed = gateDcDial({
      peer: 'aa',
      capable: true,
      aboveDc: true,
      peerInitiated: true,
      decision: decision({ level: 4, disabled: false }),
    });
    expect(allowed).toEqual({ allow: true });
    expect(planInboundOffer(decision({ level: 4, disabled: false })).action).toBe('accept');
  });

  test('disabled declines a peer-initiated offer; breaker ceiling does not', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const disabled = gateDcDial({
        peer: 'ec42f364',
        capable: true,
        aboveDc: true,
        peerInitiated: true,
        decision: decision({ level: 5, disabled: true, allow: true }),
      });
      expect(disabled.allow).toBe(false);
      expect(disabled.decline).toBe('disabled');
      const plan = planInboundOffer(decision({ level: 5, disabled: true, allow: true }));
      expect(plan).toMatchObject({ action: 'decline', reason: 'disabled' });
      if (plan.action !== 'decline') throw new Error('expected decline');
      expect(offererReactionToRemoteSdp(plan.sdp)).toBe('abort-now');

      const ceiling = gateDcDial({
        peer: 'ec42f364',
        capable: true,
        aboveDc: true,
        peerInitiated: true,
        decision: decision({ level: 5, disabled: false }),
      });
      expect(ceiling).toEqual({ allow: true });

      const outboundProbe = gateDcDial({
        peer: 'ec42f364',
        capable: true,
        aboveDc: true,
        peerInitiated: false,
        decision: decision({ level: 5, disabled: true, allow: true }),
      });
      expect(outboundProbe).toEqual({ allow: true });
    } finally {
      console.log = orig;
    }
    expect(
      lines.some((line) => line.includes('answer declined') && line.includes('cause=disabled'))
    ).toBe(true);
    expect(lines.some((line) => line.includes('cause=cooling'))).toBe(false);
    expect(lines.some((line) => line.includes('answer while cooling'))).toBe(true);
  });

  test('force-probe accept window answers instead of declining', () => {
    const allowed = gateDcDial({
      peer: 'aa',
      capable: true,
      aboveDc: true,
      peerInitiated: true,
      decision: decision({ level: 5, disabled: true, allow: false, acceptInbound: true }),
    });
    expect(allowed).toEqual({ allow: true });
  });

  test('dc-declined is not a dial failure and sets a non-escalating cooldown', () => {
    const noted: string[] = [];
    const refusals: Array<number | null> = [];
    const now = Date.now();
    const reason = noteDialDcFailure({
      stopped: false,
      nodeId: 'peer',
      err: new DcDeclinedError({
        reason: 'cooling',
        until: null,
        retryAfterMs: 50_000,
        epoch: null,
      }),
      connectP: null,
      attemptId: 'dc:1',
      peerInitiated: false,
      dcBreaker: {
        noteFailure: () => {
          noted.push('fail');
          return { counted: true, opened: false, open: false };
        },
        noteRemoteRefusal: (_peer, until) => refusals.push(until),
      },
    });
    expect(reason).toBe('dc-declined');
    expect(noted).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0] ?? 0).toBeGreaterThanOrEqual(now + 50_000);
    expect(refusals[0] ?? 0).toBeLessThan(now + 50_000 + 1_000);
  });
});
