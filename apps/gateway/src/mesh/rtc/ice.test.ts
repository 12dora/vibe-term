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
  test('collects stun urls and structured TURN IceServer entries', () => {
    expect(collectIceServers({ stun: ['stun:a:1'], turn: null })).toEqual(['stun:a:1']);
    expect(
      collectIceServers({
        stun: ['stun:a:1'],
        turn: { url: 'turn:b:3478', username: 'u', credential: 'p' },
      })
    ).toEqual([
      'stun:a:1',
      { hostname: 'b', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
    ]);
    expect(
      collectIceServers({
        stun: [],
        turn: {
          url: 'turns:relay.example:5349?transport=tcp',
          username: 'u',
          credential: 'secret',
        },
      })
    ).toEqual([
      {
        hostname: 'relay.example',
        port: 5349,
        username: 'u',
        password: 'secret',
        relayType: 'TurnTls',
      },
    ]);
    expect(
      collectIceServers({
        stun: [],
        turn: { url: 'turn:nat.example:3478?transport=tcp', username: 'n', credential: 'c' },
      })
    ).toEqual([
      { hostname: 'nat.example', port: 3478, username: 'n', password: 'c', relayType: 'TurnTcp' },
    ]);
    expect(
      collectIceServers({
        stun: ['stun:a:1'],
        turn: {
          hostname: 'kept.example',
          port: 3478,
          username: 'u',
          password: 'p',
          relayType: 'TurnUdp',
        },
      })
    ).toEqual([
      'stun:a:1',
      { hostname: 'kept.example', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
    ]);
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
