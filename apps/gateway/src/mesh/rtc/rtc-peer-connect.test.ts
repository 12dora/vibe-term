import { describe, expect, test } from 'bun:test';
import type { RtcSignalMessage } from '../mesh-deps';
import type { RtcSignaling } from './ice';
import { createIceCandidateTrace } from './rtc-log';
import { bindPeerSignaling } from './rtc-peer-connect';
import { type FakePeerConnection, createFakeNativeModule } from './test-fakes';

describe('bindPeerSignaling fake-IP ICE hosts', () => {
  test('does not signal local 198.18/15 candidates and still sends RFC1918', () => {
    const fake = createFakeNativeModule();
    const pc = new fake.module.PeerConnection('ice', { iceServers: [] }) as FakePeerConnection;
    const sent: RtcSignalMessage[] = [];
    const signaling: RtcSignaling = {
      send: (msg) => sent.push(msg),
      onMessage: () => () => {},
    };
    bindPeerSignaling(
      pc,
      signaling,
      'dc:a:b',
      'peer',
      'answer',
      (_pc, _listener) => () => {},
      1,
      createIceCandidateTrace()
    );
    pc.emitLocalCandidate('candidate:1 1 UDP 1 198.18.0.1 39001 typ host');
    pc.emitLocalCandidate('candidate:2 1 UDP 1 10.0.0.8 39001 typ host');
    pc.emitLocalCandidate('candidate:3 1 UDP 1 192.168.31.36 39001 typ host');
    const candidates = sent
      .map((row) => row.candidate)
      .filter((row): row is string => typeof row === 'string');
    expect(candidates).toHaveLength(2);
    expect(candidates.some((row) => row.includes('198.18.0.1'))).toBe(false);
    expect(candidates.some((row) => row.includes('10.0.0.8'))).toBe(true);
    expect(candidates.some((row) => row.includes('192.168.31.36'))).toBe(true);
    pc.close();
  });
});
