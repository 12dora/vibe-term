import { describe, expect, test } from 'bun:test';
import { createRtcDialProgress, rtcFailureStage, rtcGatherFailureHint } from './rtc-dial-progress';

describe('rtcFailureStage', () => {
  test('walks gathering → no-remote-sdp → checking → dtls → handshake', () => {
    const progress = createRtcDialProgress();
    expect(rtcFailureStage(progress)).toBe('gathering');
    progress.gatheringComplete = true;
    expect(rtcFailureStage(progress)).toBe('no-remote-sdp');
    progress.remoteDescriptionApplied = true;
    expect(rtcFailureStage(progress)).toBe('checking');
    progress.selectedPair = true;
    expect(rtcFailureStage(progress)).toBe('dtls');
    progress.channelOpen = true;
    expect(rtcFailureStage(progress)).toBe('handshake');
  });

  test('most-advanced progress wins when gathering is still incomplete', () => {
    const progress = createRtcDialProgress();
    progress.selectedPair = true;
    expect(rtcFailureStage(progress)).toBe('dtls');
    progress.channelOpen = true;
    expect(rtcFailureStage(progress)).toBe('handshake');
  });
});

describe('rtcGatherFailureHint', () => {
  test('empty STUN list is stun unconfigured; zero srflx with STUN is no srflx', () => {
    const progress = createRtcDialProgress();
    progress.gatheringComplete = true;
    expect(rtcGatherFailureHint(progress, { stun: [], turn: null }, { srflx: 0, relay: 0 })).toBe(
      'stun unconfigured'
    );
    expect(
      rtcGatherFailureHint(
        progress,
        { stun: ['stun:example:3478'], turn: null },
        { srflx: 0, relay: 0 }
      )
    ).toBe('no srflx candidates');
    expect(
      rtcGatherFailureHint(
        progress,
        { stun: ['stun:example:3478'], turn: null },
        { srflx: 1, relay: 0 }
      )
    ).toBeNull();
  });

  test('does not rewrite a dtls/handshake timeout as stun unconfigured', () => {
    const progress = createRtcDialProgress();
    progress.selectedPair = true;
    expect(
      rtcGatherFailureHint(progress, { stun: [], turn: null }, { srflx: 0, relay: 0 })
    ).toBeNull();
    progress.channelOpen = true;
    expect(
      rtcGatherFailureHint(progress, { stun: [], turn: null }, { srflx: 0, relay: 0 })
    ).toBeNull();
  });
});
