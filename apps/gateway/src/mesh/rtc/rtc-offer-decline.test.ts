import { describe, expect, test } from 'bun:test';
import type { PeerConnectionLike } from './native';
import {
  consumeOffererOnDecline,
  dcOfferDeclineCtl,
  encodeDcOfferDecline,
  isDcOfferDecline,
  offererReactionToRemoteSdp,
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
    let superseded = 0;
    const pc = {
      setRemoteDescription() {
        applied = true;
      },
    } as unknown as PeerConnectionLike;
    const state = createSignalingAttemptState(1);
    state.onSuperseded = () => {
      superseded += 1;
    };
    expect(applyRemoteSdp(pc, 'ec42f364', 'answer', state, raw)).toBe('dropped');
    expect(applied).toBe(false);
    expect(superseded).toBe(1);

    const ctl = dcOfferDeclineCtl({
      rtcSession: 'dc:a:b',
      to: 'ec42f364',
      reason: 'disabled',
    });
    expect(ctl).toMatchObject({ t: 'rtc.signal', from: 'node', to: 'ec42f364' });
    expect(isDcOfferDecline(ctl.sdp)).toBe(true);
  });
});
