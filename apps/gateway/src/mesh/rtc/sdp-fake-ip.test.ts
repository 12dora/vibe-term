import { describe, expect, test } from 'bun:test';
import { parseSdpFingerprint } from '@vibeterm/shared/auth';
import type { LocalDescriptionFanout } from './rtc-peer-helpers';
import { publishLocalDescription, stripFakeIpSdpCandidates } from './sdp-fake-ip';

const ANSWER = [
  'v=0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 AA:BB',
  'a=candidate:1 1 UDP 2114977791 192.168.31.36 58382 typ host',
  'a=candidate:2 1 UDP 2114977535 198.18.0.1 58382 typ host',
  'a=candidate:3 1 UDP 2114977279 198.19.255.255 58382 typ host',
  'a=candidate:4 1 UDP 2114977000 ::ffff:198.18.0.1 58382 typ host',
  'a=candidate:5 1 UDP 2114976000 10.0.0.8 58382 typ host',
  'a=candidate:6 1 UDP 1678769151 152.70.84.203 52407 typ srflx',
].join('\r\n');

describe('stripFakeIpSdpCandidates', () => {
  test('drops 198.18/15 and ipv4-mapped fake hosts, keeps the rest of the SDP', () => {
    const stripped = stripFakeIpSdpCandidates(ANSWER);
    expect(stripped.dropped).toBe(3);
    expect(stripped.sdp).not.toContain('198.18.0.1');
    expect(stripped.sdp).not.toContain('198.19.255.255');
    expect(stripped.sdp).toContain('192.168.31.36');
    expect(stripped.sdp).toContain('10.0.0.8');
    expect(stripped.sdp).toContain('152.70.84.203');
    expect(stripped.sdp).toContain('a=fingerprint:sha-256 AA:BB');
    expect(parseSdpFingerprint(stripped.sdp)).toEqual({ algorithm: 'sha-256', value: 'AABB' });
    expect(stripped.sdp.includes('\r\n')).toBe(true);
  });

  test('publishLocalDescription hands listeners the filtered SDP and logs the drop', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const seen: string[] = [];
      const fanout: LocalDescriptionFanout = { latest: null, listeners: new Set() };
      fanout.listeners.add((description) => seen.push(description.sdp));
      publishLocalDescription(fanout, ANSWER, 'answer');
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain('198.18.');
      expect(fanout.latest?.type).toBe('answer');
      expect(
        lines.some((line) => line.includes('cause=fake-ip') && line.includes('kind=sdp'))
      ).toBe(true);
    } finally {
      console.log = original;
    }
  });
});
