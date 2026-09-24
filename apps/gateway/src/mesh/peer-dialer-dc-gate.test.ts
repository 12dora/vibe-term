import { describe, expect, test } from 'bun:test';
import { gateDcDial, planInboundOffer } from './peer-dialer-dc-gate';
import type { RtcDialBreakerDecision } from './rtc/rtc-dial-breaker';
import { offererReactionToRemoteSdp } from './rtc/rtc-offer-decline';

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

  test('disabled and ceiling cooling decline fast and do not allow a PC', () => {
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
      expect(ceiling).toMatchObject({ allow: false, decline: 'cooling' });

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
    expect(lines.some((line) => line.includes('cause=cooling'))).toBe(true);
    expect(lines.some((line) => line.includes('answer while cooling'))).toBe(false);
  });
});
