import { describe, expect, test } from 'bun:test';
import { decodeSdpSignal } from './ice';
import type { PeerConnectionLike } from './native';
import { RTC_DECLINE_BACKOFF_CAP_MS } from './rtc-force-probe';
import {
  consumeOffererOnDecline,
  dcOfferDeclineCtl,
  declineBackoffUntil,
  encodeDcOfferDecline,
  isDcOfferDecline,
  offererReactionToRemoteSdp,
  readDcOfferDeclineDetail,
} from './rtc-offer-decline';
import { applyRemoteSdp, createSignalingAttemptState } from './rtc-signal-apply';

describe('dc offer decline', () => {
  test('new offerer aborts immediately; decline is not applied as an answer', () => {
    const raw = encodeDcOfferDecline('disabled');
    expect(isDcOfferDecline(raw)).toBe(true);
    expect(offererReactionToRemoteSdp(raw)).toBe('abort-now');
    expect(offererReactionToRemoteSdp(encodeDcOfferDecline('cooling'))).toBe('abort-now');
    let aborted = false;
    const started = Date.now();
    expect(
      consumeOffererOnDecline(raw, () => {
        aborted = true;
      })
    ).toBe(true);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      consumeOffererOnDecline('v=0\r\n', () => {
        throw new Error('raw offer must not abort');
      })
    ).toBe(false);

    let applied = false;
    let declined = 0;
    const pc = {
      setRemoteDescription() {
        applied = true;
      },
    } as unknown as PeerConnectionLike;
    const state = createSignalingAttemptState(1);
    state.onDeclined = () => {
      declined += 1;
    };
    expect(applyRemoteSdp(pc, 'ec42f364', 'answer', state, raw)).toBe('dropped');
    expect(applied).toBe(false);
    expect(declined).toBe(1);

    const ctl = dcOfferDeclineCtl({
      rtcSession: 'dc:a:b',
      to: 'ec42f364',
      reason: 'disabled',
    });
    expect(ctl).toMatchObject({ t: 'rtc.signal', from: 'node', to: 'ec42f364' });
    expect(isDcOfferDecline(ctl.sdp)).toBe(true);
  });

  test('decline keeps the sdp shape and carries cooldown for new offerers only', () => {
    const raw = encodeDcOfferDecline('cooling', { until: 5_000, retryAfterMs: 4_000 });
    expect(decodeSdpSignal(raw)).toMatchObject({ type: 'decline', sdp: 'cooling' });
    expect(readDcOfferDeclineDetail(raw)).toEqual({
      reason: 'cooling',
      until: 5_000,
      retryAfterMs: 4_000,
      epoch: null,
    });
    expect(readDcOfferDeclineDetail('{"type":"decline","sdp":"disabled"}')).toEqual({
      reason: 'disabled',
      until: null,
      retryAfterMs: null,
      epoch: null,
    });
    const ctl = dcOfferDeclineCtl({
      rtcSession: 'dc:a:b',
      to: 'peer',
      reason: 'disabled',
      until: null,
      retryAfterMs: 600_000,
    });
    expect(readDcOfferDeclineDetail(ctl.sdp)?.retryAfterMs).toBe(600_000);
  });

  test('decline backoff ignores NaN and the past, and clamps a far future to 30 min', () => {
    const now = 10_000;
    expect(declineBackoffUntil({ retryAfterMs: Number.NaN }, now)).toBeNull();
    expect(declineBackoffUntil({ retryAfterMs: -5 }, now)).toBeNull();
    expect(declineBackoffUntil({ until: now - 1 }, now)).toBeNull();
    expect(declineBackoffUntil({ until: Number.POSITIVE_INFINITY }, now)).toBeNull();
    expect(declineBackoffUntil({ retryAfterMs: 1e12 }, now)).toBe(now + RTC_DECLINE_BACKOFF_CAP_MS);
    expect(declineBackoffUntil({ until: now + 1e12 }, now)).toBe(now + RTC_DECLINE_BACKOFF_CAP_MS);
    expect(declineBackoffUntil({ retryAfterMs: 5_000, until: now + 1e12 }, now)).toBe(now + 5_000);
  });
});
