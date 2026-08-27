import { describe, expect, test } from 'bun:test';
import * as shared from '@tmex/shared/auth';
import { fingerprintsEqual, normalizeFingerprint, parseSdpFingerprint } from './fingerprint';

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=fingerprint:SHA-256 AA:bb:CC:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
].join('\r\n');

describe('parseSdpFingerprint', () => {
  test('解出小写算法名 + 大写去冒号的十六进制', () => {
    const fp = parseSdpFingerprint(SDP);
    expect(fp?.algorithm).toBe('sha-256');
    expect(fp?.value).toBe('AABBCC112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDD');
  });

  test('没有 a=fingerprint 行时返回 null', () => {
    expect(parseSdpFingerprint('v=0\r\na=mid:0\r\n')).toBeNull();
  });

  test('与 @tmex/shared/auth 的实现逐字段一致（浏览器侧重写的对拍）', () => {
    const samples = [
      SDP,
      SDP.replace(/\r\n/g, '\n'),
      `${SDP}\r\n`,
      'v=0\na=fingerprint:sha-1 0a:1B:2c\n',
      'v=0\r\na=mid:0\r\n',
    ];
    for (const sample of samples) {
      expect(parseSdpFingerprint(sample)).toEqual(shared.parseSdpFingerprint(sample));
    }
  });

  test('normalizeFingerprint 与 shared 一致', () => {
    const raw = { algorithm: ' SHA-256 ', value: 'aa:bb cc' };
    expect(normalizeFingerprint(raw)).toEqual(shared.normalizeFingerprint(raw));
  });
});

describe('fingerprintsEqual', () => {
  test('大小写 / 冒号差异视为相等', () => {
    expect(
      fingerprintsEqual(
        { algorithm: 'SHA-256', value: 'aa:bb' },
        { algorithm: 'sha-256', value: 'AABB' }
      )
    ).toBe(true);
  });

  test('算法或值不同、任一为空都视为不等', () => {
    expect(
      fingerprintsEqual(
        { algorithm: 'sha-256', value: 'AABB' },
        { algorithm: 'sha-1', value: 'AABB' }
      )
    ).toBe(false);
    expect(
      fingerprintsEqual(
        { algorithm: 'sha-256', value: 'AABB' },
        { algorithm: 'sha-256', value: 'CCDD' }
      )
    ).toBe(false);
    expect(fingerprintsEqual(null, { algorithm: 'sha-256', value: 'AABB' })).toBe(false);
  });
});
