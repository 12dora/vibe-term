import { describe, expect, test } from 'bun:test';
import * as shared from '@tmex/shared/auth';
import { fingerprintsEqual, normalizeFingerprint, parseSdpFingerprint } from './fingerprint';

const FP_A =
  'AA:bb:CC:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD';
const FP_A_NORMALIZED = 'AABBCC112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDD';
const FP_B =
  '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
const FP_B_NORMALIZED = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF';

function sdp(lines: string[]): string {
  return lines.join('\r\n');
}

const SESSION_HEAD = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0'];
const APPLICATION_HEAD = [
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
];

const MEDIA_LEVEL = sdp([
  ...SESSION_HEAD,
  ...APPLICATION_HEAD,
  `a=fingerprint:SHA-256 ${FP_A}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
]);

const SESSION_LEVEL = sdp([
  ...SESSION_HEAD,
  `a=fingerprint:sha-256 ${FP_A}`,
  ...APPLICATION_HEAD,
  'a=mid:0',
]);

describe('parseSdpFingerprint（RFC 8122 作用域）', () => {
  test('m=application 段内的指纹：小写算法名 + 大写去冒号十六进制', () => {
    expect(parseSdpFingerprint(MEDIA_LEVEL)).toEqual({
      algorithm: 'sha-256',
      value: FP_A_NORMALIZED,
    });
  });

  test('media 段没有指纹时回落 session 级', () => {
    expect(parseSdpFingerprint(SESSION_LEVEL)).toEqual({
      algorithm: 'sha-256',
      value: FP_A_NORMALIZED,
    });
  });

  test('media 级覆盖 session 级：不取 session 里那条（挡失陷 hub 的 MITM）', () => {
    // 失陷 hub 保留合法的 fp_node 作为 session 级指纹，往 m=application 段注入自己的证书指纹。
    const attack = sdp([
      ...SESSION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      ...APPLICATION_HEAD,
      `a=fingerprint:sha-256 ${FP_B}`,
      'a=mid:0',
    ]);
    expect(parseSdpFingerprint(attack)).toEqual({
      algorithm: 'sha-256',
      value: FP_B_NORMALIZED,
    });
  });

  test('同一段内出现冲突 / 多余的有效指纹一律拒绝', () => {
    const conflicting = sdp([
      ...SESSION_HEAD,
      ...APPLICATION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      `a=fingerprint:sha-256 ${FP_B}`,
      'a=mid:0',
    ]);
    expect(parseSdpFingerprint(conflicting)).toBeNull();

    const multiAlgorithm = sdp([
      ...SESSION_HEAD,
      ...APPLICATION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      'a=fingerprint:sha-1 0A:1B:2C',
      'a=mid:0',
    ]);
    expect(parseSdpFingerprint(multiAlgorithm)).toBeNull();

    // 同一条重复出现不算冲突
    const duplicated = sdp([
      ...SESSION_HEAD,
      ...APPLICATION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      `a=fingerprint:sha-256 ${FP_A.toLowerCase()}`,
      'a=mid:0',
    ]);
    expect(parseSdpFingerprint(duplicated)?.value).toBe(FP_A_NORMALIZED);
  });

  test('多个 m=application 段无法判定载体用哪条，拒绝', () => {
    const twoSections = sdp([
      ...SESSION_HEAD,
      ...APPLICATION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      'a=mid:0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      `a=fingerprint:sha-256 ${FP_B}`,
      'a=mid:1',
    ]);
    expect(parseSdpFingerprint(twoSections)).toBeNull();
  });

  test('只有音视频段（没有 m=application）时拒绝', () => {
    const audioOnly = sdp([
      ...SESSION_HEAD,
      `a=fingerprint:sha-256 ${FP_A}`,
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:0',
    ]);
    expect(parseSdpFingerprint(audioOnly)).toBeNull();
  });

  test('缺指纹、非 sha-256、畸形行一律 null', () => {
    expect(parseSdpFingerprint(sdp([...SESSION_HEAD, ...APPLICATION_HEAD, 'a=mid:0']))).toBeNull();
    expect(
      parseSdpFingerprint(sdp([...SESSION_HEAD, ...APPLICATION_HEAD, 'a=fingerprint:sha-1 0A:1B']))
    ).toBeNull();
    expect(
      parseSdpFingerprint(sdp([...SESSION_HEAD, ...APPLICATION_HEAD, 'a=fingerprint:sha-256']))
    ).toBeNull();
    expect(parseSdpFingerprint('')).toBeNull();
  });

  test('LF / CRLF、行尾空白与结尾换行都能解析', () => {
    expect(parseSdpFingerprint(MEDIA_LEVEL.replace(/\r\n/g, '\n'))?.value).toBe(FP_A_NORMALIZED);
    expect(parseSdpFingerprint(`${MEDIA_LEVEL}\r\n`)?.value).toBe(FP_A_NORMALIZED);
    expect(parseSdpFingerprint(MEDIA_LEVEL.replace(/\r\n/g, '  \r\n'))?.value).toBe(
      FP_A_NORMALIZED
    );
  });

  test('normalizeFingerprint 与 @tmex/shared/auth 逐字段一致', () => {
    // parseSdpFingerprint 与 shared 的宽松首条匹配**刻意不等价**（见本模块头注释），
    // 只有归一化语义要求完全一致。
    const raw = { algorithm: ' SHA-256 ', value: 'aa:bb cc' };
    expect(normalizeFingerprint(raw)).toEqual(shared.normalizeFingerprint(raw));
    expect(normalizeFingerprint({ algorithm: 'SHA-1', value: '0a:1B:2c' })).toEqual(
      shared.normalizeFingerprint({ algorithm: 'SHA-1', value: '0a:1B:2c' })
    );
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
