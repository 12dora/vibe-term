import { describe, expect, test } from 'bun:test';
import {
  encodeBase64url,
  generateEd25519KeyPair,
  randomBytes,
  signEd25519,
} from '@tmex/shared/auth';
import {
  RTC_WAKE_DOMAIN,
  RTC_WAKE_MAX_SKEW_MS,
  buildRtcIceConfig,
  collectIceServers,
  decodeCandidateSignal,
  decodeSdpSignal,
  encodeCandidateSignal,
  encodeRtcWakeSdp,
  encodeSdpSignal,
  isEmptyCandidate,
  isRtcWakeSdp,
  maskIceAddress,
  maskIceCandidate,
  parseIceCandidateType,
  parseRtcWakeSdp,
  peerRtcSession,
  rtcWakeCanonicalBytes,
  verifyRtcWakeSignature,
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

  test('wake sdp is distinguishable and does not decode as a real description', () => {
    const pair = generateEd25519KeyPair();
    const from = 'aa'.repeat(16);
    const to = 'bb'.repeat(16);
    const wake = encodeRtcWakeSdp({
      from,
      to,
      rtcSession: peerRtcSession(from, to),
      issuedAt: 1_700_000_000_000,
      secretKey: pair.secretKey,
    });
    expect(isRtcWakeSdp(wake)).toBe(true);
    expect(decodeSdpSignal(wake)).toBeNull();
    expect(isRtcWakeSdp(encodeSdpSignal({ type: 'offer', sdp: 'v=0' }))).toBe(false);
    expect(isRtcWakeSdp(null)).toBe(false);
    const parsed = parseRtcWakeSdp(wake);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.domain).toBe(RTC_WAKE_DOMAIN);
    expect(parsed.from).toBe(from);
    expect(parsed.to).toBe(to);
    expect(verifyRtcWakeSignature(parsed, pair.publicKey)).toBe(true);
    const other = generateEd25519KeyPair();
    expect(verifyRtcWakeSignature(parsed, other.publicKey)).toBe(false);
  });

  test('wake signature covers domain/from/to/rtcSession/nonce/issued_at', () => {
    const pair = generateEd25519KeyPair();
    const from = '11'.repeat(16);
    const to = '22'.repeat(16);
    const nonce = encodeBase64url(randomBytes(16));
    const issued_at = 1_700_000_000_000;
    const rtcSession = peerRtcSession(from, to);
    const sig = encodeBase64url(
      signEd25519(pair.secretKey, rtcWakeCanonicalBytes({ from, to, rtcSession, nonce, issued_at }))
    );
    expect(
      verifyRtcWakeSignature(
        {
          type: 'rtc.wake',
          domain: RTC_WAKE_DOMAIN,
          from,
          to,
          rtcSession,
          nonce,
          issued_at,
          sig,
        },
        pair.publicKey
      )
    ).toBe(true);
    expect(
      verifyRtcWakeSignature(
        {
          type: 'rtc.wake',
          domain: RTC_WAKE_DOMAIN,
          from: to,
          to: from,
          rtcSession,
          nonce,
          issued_at,
          sig,
        },
        pair.publicKey
      )
    ).toBe(false);
    expect(RTC_WAKE_MAX_SKEW_MS).toBe(60_000);
  });

  test('parses ICE candidate type and masks addresses to /24 or last octet', () => {
    expect(parseIceCandidateType('candidate:1 1 UDP 1 10.0.1.55 9 typ host')).toBe('host');
    expect(
      parseIceCandidateType(
        'candidate:2 1 UDP 1 203.0.113.44 3478 typ srflx raddr 10.0.1.55 rport 9'
      )
    ).toBe('srflx');
    expect(parseIceCandidateType('candidate:3 1 UDP 1 192.0.2.8 9 typ prflx')).toBe('prflx');
    expect(parseIceCandidateType('candidate:4 1 UDP 1 198.51.100.2 9 typ relay')).toBe('relay');
    expect(maskIceAddress('10.0.1.55')).toBe('10.0.1.0');
    expect(maskIceAddress('203.0.113.44')).toBe('203.0.113.0');
    expect(maskIceAddress('2001:db8:abcd:0012:0000:0000:0000:00ff')).toBe('2001:db8:abcd::');
    expect(maskIceAddress('::ffff:192.168.1.42')).toBe('::ffff:192.168.1.0');
    expect(maskIceAddress('[::ffff:192.168.1.42]:5000')).toBe('[::ffff:192.168.1.0]:5000');
    expect(maskIceAddress('[2001:db8:abcd:0012::1]:3478')).toBe('[2001:db8:abcd::]:3478');
    expect(maskIceAddress('192.168.1.42:3478')).toBe('192.168.1.0:3478');
    expect(
      maskIceCandidate('candidate:2 1 UDP 1 203.0.113.44 3478 typ srflx raddr 10.0.1.55 rport 9')
    ).toContain('203.0.113.0');
    expect(
      maskIceCandidate('candidate:2 1 UDP 1 203.0.113.44 3478 typ srflx raddr 10.0.1.55 rport 9')
    ).not.toContain('203.0.113.44');
    expect(
      maskIceCandidate('candidate:2 1 UDP 1 203.0.113.44 3478 typ srflx raddr 10.0.1.55 rport 9')
    ).not.toContain('10.0.1.55');
  });
});
