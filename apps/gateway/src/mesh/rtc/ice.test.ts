import { describe, expect, test } from 'bun:test';
import {
  buildRtcIceConfig,
  collectIceServers,
  decodeCandidateSignal,
  decodeSdpSignal,
  encodeCandidateSignal,
  encodeSdpSignal,
  isEmptyCandidate,
  peerRtcSession,
} from './ice';

describe('ice helpers', () => {
  test('collects stun and turn urls', () => {
    expect(collectIceServers({ stun: ['stun:a:1'], turn: null })).toEqual(['stun:a:1']);
    expect(
      collectIceServers({
        stun: ['stun:a:1'],
        turn: { url: 'turn:b:3478', username: 'u', credential: 'p' },
      })
    ).toEqual(['stun:a:1', 'turn:b:3478']);
    expect(buildRtcIceConfig({ stun: ['stun:a:1'], turn: null }).iceServers).toEqual(['stun:a:1']);
  });

  test('encodes and decodes sdp / candidate signals', () => {
    const sdp = encodeSdpSignal({ type: 'offer', sdp: 'v=0' });
    expect(decodeSdpSignal(sdp)).toEqual({ type: 'offer', sdp: 'v=0' });
    expect(decodeSdpSignal('v=0\na=x')).toEqual({ type: 'offer', sdp: 'v=0\na=x' });
    const cand = encodeCandidateSignal('candidate:1', '0');
    expect(decodeCandidateSignal(cand)).toEqual({ candidate: 'candidate:1', mid: '0' });
    expect(isEmptyCandidate('')).toBe(true);
    expect(isEmptyCandidate('candidate:1')).toBe(false);
  });

  test('peerRtcSession is stable regardless of argument order', () => {
    expect(peerRtcSession('aa', 'bb')).toBe(peerRtcSession('bb', 'aa'));
    expect(peerRtcSession('aa', 'bb')).toBe('dc:aa:bb');
  });
});
