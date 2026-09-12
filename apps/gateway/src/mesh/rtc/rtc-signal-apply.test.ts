import { describe, expect, test } from 'bun:test';
import { encodeCandidateSignal, encodeSdpSignal } from './ice';
import type { PeerConnectionLike } from './native';
import { createIceCandidateTrace } from './rtc-log';
import {
  RTC_PENDING_CANDIDATE_MAX,
  createRtcSignalApplier,
  createSignalingAttemptState,
  isFakeIpv4IceCandidate,
} from './rtc-signal-apply';

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

  test('rejects offers older than lastOfferEpoch even when expected is unset', () => {
    const { pc, remote } = fakePc();
    const state = createSignalingAttemptState(undefined, 4);
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0-stale', epoch: 3 }),
    });
    expect(remote).toHaveLength(0);
    expect(state.epoch).toBeUndefined();
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 4 }),
    });
    expect(remote).toHaveLength(1);
    expect(state.epoch).toBe(4);
    expect(state.lastOfferEpoch).toBe(4);
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

  test('candidates arriving before the offer are queued and flushed with it', () => {
    const { pc, remote, candidates } = fakePc();
    const state = createSignalingAttemptState();
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', 7),
    });
    expect(candidates).toHaveLength(0);
    expect(state.pendingCandidates).toHaveLength(1);
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 7 }),
    });
    expect(remote).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });

  test('queued candidates from another epoch are discarded when the offer lands', () => {
    const { pc, candidates } = fakePc();
    const state = createSignalingAttemptState();
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    const queue = (epoch: number, n: number) => {
      apply({
        rtcSession: 'dc:a:b',
        from: 'node',
        to: 'peer',
        candidate: encodeCandidateSignal(
          `candidate:${n} 1 UDP 1 10.0.0.${n} 9 typ host`,
          '0',
          epoch
        ),
      });
    };
    queue(5, 1);
    queue(7, 2);
    queue(5, 3);
    expect(state.pendingCandidates).toHaveLength(3);
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'offer', sdp: 'v=0', epoch: 7 }),
    });
    expect(candidates).toEqual([
      { candidate: 'candidate:2 1 UDP 1 10.0.0.2 9 typ host', mid: '0' },
    ]);
  });

  test('pending candidates are deduped and capped per attempt', () => {
    const { pc } = fakePc();
    const state = createSignalingAttemptState();
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    const queue = (candidate: string, epoch = 7) => {
      apply({
        rtcSession: 'dc:a:b',
        from: 'node',
        to: 'peer',
        candidate: encodeCandidateSignal(candidate, '0', epoch),
      });
    };
    const same = 'candidate:1 1 UDP 1 10.0.0.1 9 typ host';
    queue(same);
    queue(same);
    queue(same);
    expect(state.pendingCandidates).toHaveLength(1);
    expect(state.pendingDropped).toBe(2);
    // 同一条候选换 epoch 不算重复
    queue(same, 8);
    expect(state.pendingCandidates).toHaveLength(2);
    const flood = RTC_PENDING_CANDIDATE_MAX + 10;
    for (let i = 0; i < flood; i += 1) {
      queue(`candidate:${i + 2} 1 UDP 1 10.0.1.${i % 250} 9 typ host`);
    }
    expect(state.pendingCandidates).toHaveLength(RTC_PENDING_CANDIDATE_MAX);
    // 2 条重复 + 队列剩 62 个位置后被拒的 flood-62 条
    expect(state.pendingDropped).toBe(2 + flood - (RTC_PENDING_CANDIDATE_MAX - 2));
  });

  test('candidates older than lastOfferEpoch are still rejected before the offer', () => {
    const { pc, candidates } = fakePc();
    const state = createSignalingAttemptState(undefined, 9);
    const apply = createRtcSignalApplier(pc, 'peer', 'offer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 10.0.0.1 9 typ host', '0', 3),
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

  test('drops 198.18/15 fake-IP remote candidates and keeps RFC1918', () => {
    expect(isFakeIpv4IceCandidate('candidate:1 1 UDP 1 198.18.0.1 9 typ host')).toBe(true);
    expect(isFakeIpv4IceCandidate('candidate:1 1 UDP 1 198.19.255.255 9 typ host')).toBe(true);
    expect(isFakeIpv4IceCandidate('candidate:1 1 UDP 1 192.168.31.36 9 typ host')).toBe(false);
    expect(isFakeIpv4IceCandidate('candidate:1 1 UDP 1 10.0.0.148 9 typ host')).toBe(false);
    const { pc, candidates } = fakePc();
    const state = createSignalingAttemptState(1);
    const apply = createRtcSignalApplier(pc, 'peer', 'answer', state, createIceCandidateTrace());
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      sdp: encodeSdpSignal({ type: 'answer', sdp: 'v=0', epoch: 1 }),
    });
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:1 1 UDP 1 198.18.0.1 54321 typ host', '0', 1),
    });
    apply({
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'peer',
      candidate: encodeCandidateSignal('candidate:2 1 UDP 1 192.168.1.8 9 typ host', '0', 1),
    });
    expect(candidates).toEqual([
      { candidate: 'candidate:2 1 UDP 1 192.168.1.8 9 typ host', mid: '0' },
    ]);
  });
});
