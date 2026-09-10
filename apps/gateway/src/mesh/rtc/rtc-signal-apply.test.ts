import { describe, expect, test } from 'bun:test';
import { encodeCandidateSignal, encodeSdpSignal } from './ice';
import type { PeerConnectionLike } from './native';
import { createIceCandidateTrace } from './rtc-log';
import { createRtcSignalApplier, createSignalingAttemptState } from './rtc-signal-apply';

function fakePc(opts?: { throwOnRemote?: boolean; throwOnCandidate?: boolean }) {
  const remote: Array<{ sdp: string; type: string }> = [];
  const candidates: Array<{ candidate: string; mid: string }> = [];
  const pc = {
    setRemoteDescription(sdp: string, type: string) {
      if (opts?.throwOnRemote) throw new Error('setRemoteDescription failed');
      remote.push({ sdp, type });
    },
    addRemoteCandidate(candidate: string, mid: string) {
      if (opts?.throwOnCandidate)
        throw new Error('Got a remote candidate without remote description');
      if (remote.length === 0) throw new Error('Got a remote candidate without remote description');
      candidates.push({ candidate, mid });
    },
  } as unknown as PeerConnectionLike;
  return { pc, remote, candidates };
}

describe('createRtcSignalApplier', () => {
  test('answerer adopts the first offer epoch and drops older ones', () => {
    const { pc, remote } = fakePc();
    const state = createSignalingAttemptState();
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 3 }),
    });
    expect(state.epoch).toBe(3);
    expect(remote).toHaveLength(1);
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0-old', epoch: 2 }),
    });
    expect(remote).toHaveLength(1);
  });

  test('a newer offer supersedes the in-flight answerer PC', () => {
    const { pc, remote } = fakePc();
    const state = createSignalingAttemptState(3);
    const superseded: number[] = [];
    state.onSuperseded = () => superseded.push(1);
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0-new', epoch: 4 }),
    });
    expect(superseded).toEqual([1]);
    expect(remote).toHaveLength(0);
    expect(state.epoch).toBe(3);
  });

  test('duplicate answers are dropped', () => {
    const { pc, remote } = fakePc();
    const state = createSignalingAttemptState(1);
    const apply = createRtcSignalApplier(pc, 'peer', 'answer', state, createIceCandidateTrace());
    const answer = {
      rtcSession: 'dc:a:b',
      from: 'node' as const,
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 1 }),
    };
    apply(answer);
    apply(answer);
    expect(remote).toHaveLength(1);
    expect(state.answerApplied).toBe(true);
  });

  test('candidates before a known epoch are rejected', () => {
    const { pc, candidates } = fakePc();
    const state = createSignalingAttemptState();
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', 1),
    });
    expect(candidates).toHaveLength(0);
    expect(state.pendingCandidates).toHaveLength(0);
  });

  test('candidates wait until setRemoteDescription succeeds', () => {
    const { pc, remote, candidates } = fakePc({ throwOnRemote: true });
    const state = createSignalingAttemptState(1);
    const apply = createRtcSignalApplier(pc, 'peer', 'answer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 1 }),
    });
    expect(remote).toHaveLength(0);
    expect(state.remoteDescriptionApplied).toBe(false);
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', 1),
    });
    expect(candidates).toHaveLength(0);
    expect(state.pendingCandidates).toHaveLength(1);

    const ok = fakePc();
    const flushed = createSignalingAttemptState(1);
    const applyOk = createRtcSignalApplier(
      ok.pc,
      'peer',
      'answer',
      flushed,
      createIceCandidateTrace()
    );
    applyOk({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 1 }),
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', 1),
    });
    expect(ok.remote).toHaveLength(1);
    expect(ok.candidates).toHaveLength(1);
  });
});
