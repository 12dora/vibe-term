import { describe, expect, it } from 'bun:test';
import { encodeBase64url } from '../auth/encoding';
import {
  RELAY_CTL_MAX_BYTES,
  RELAY_CTL_TYPES,
  RELAY_KEYLOG_PAGE_MAX_LIMIT,
  RELAY_PROTO_VERSION,
  RelayCtlError,
  type RelayCtlMessage,
  decodeRelayCtl,
  encodeRelayCtl,
  relaySeqFromWire,
  relaySeqToWire,
} from './codec';

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);
const TENANT = 'cd'.repeat(16);
const B32 = encodeBase64url(new Uint8Array(32).fill(7));
const B64 = encodeBase64url(new Uint8Array(64).fill(9));
const ENVELOPE = {
  v: 1 as const,
  epoch: 4,
  n: encodeBase64url(new Uint8Array(12).fill(3)),
  ct: encodeBase64url(new Uint8Array(40).fill(5)),
};
const RTC = { stun: ['stun:stun.example.com:3478'], turn: null };

const RELAY_CTL_SAMPLES: RelayCtlMessage[] = [
  { t: 'auth.challenge', nonce: B32 },
  {
    t: 'relay.auth',
    tenant_id: TENANT,
    token: B32,
    node_id: NODE_A,
    sig: B64,
    proto: RELAY_PROTO_VERSION,
    client_version: '1.1.23',
    member: { bytes: encodeBase64url(new Uint8Array(10).fill(1)), sig: B64 },
  },
  { t: 'auth.ok', tenant_id: TENANT, key_log_head_seq: 12, rtc: RTC },
  { t: 'ping' },
  { t: 'pong' },
  { t: 'relay.status', blob: ENVELOPE, epoch: 4, direct_capable: true },
  {
    t: 'relay.list',
    version: 3,
    nodes: [
      {
        id: NODE_A,
        online: true,
        status: 'admitted',
        direct_capable: true,
        epoch: 4,
        blob: ENVELOPE,
      },
      { id: NODE_B, online: false, status: 'pending', direct_capable: false },
    ],
    rtc: RTC,
    key_log_head_seq: 12,
  },
  { t: 'relay.keylog.append', id: 'req-1', seq: 13, blob: ENVELOPE },
  { t: 'relay.keylog.ack', id: 'req-1', ok: false, error: 'SEQ_MISMATCH', head: 12 },
  { t: 'relay.keylog.req', from_seq: 1, limit: 32 },
  { t: 'relay.keylog.res', records: [{ seq: 1, blob: ENVELOPE }], has_more: true },
  { t: 'relay.keylog.push', records: [{ seq: 13, blob: ENVELOPE }] },
  { t: 'relay.rtc', rtcSession: 'sess-1', from: 'node', to: NODE_B, enc: ENVELOPE },
  {
    t: 'relay.enroll.create',
    id: 'enr-1',
    enroll_pk: B32,
    authorization: encodeBase64url(new Uint8Array(80).fill(2)),
    authorization_sig: B64,
    exp: 1_760_000_000_000,
  },
  { t: 'relay.enroll.ack', id: 'enr-1', ok: true },
  {
    t: 'enroll.redeemed',
    certificate: encodeBase64url(new Uint8Array(140).fill(4)),
    cert_sig: B64,
    enroll_pk: B32,
    node_id: NODE_B,
  },
  { t: 'relay.quota', maxNodes: 8, maxStreams: 32, bandwidthBytesPerSec: null },
  { t: 'relay.kicked', reason: 'password_rotated' },
];

describe('relay ctl 编解码', () => {
  it('样例覆盖全部 ctl 类型', () => {
    expect(RELAY_CTL_SAMPLES.map((msg) => msg.t).sort()).toEqual([...RELAY_CTL_TYPES].sort());
  });

  it('每种类型 round-trip 一致', () => {
    for (const msg of RELAY_CTL_SAMPLES) {
      expect(decodeRelayCtl(encodeRelayCtl(msg))).toEqual(msg);
    }
  });

  it('接受字符串输入并丢弃未知字段', () => {
    const wire = JSON.stringify({ t: 'ping', extra: 'x' });
    expect(decodeRelayCtl(wire)).toEqual({ t: 'ping' });
  });

  it('可选字段缺省时不出现在 wire 上', () => {
    const bytes = encodeRelayCtl({ t: 'relay.keylog.req', from_seq: 5 });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      t: 'relay.keylog.req',
      from_seq: 5,
    });
  });
});

describe('relay ctl 防御性校验', () => {
  it('拒绝未知类型与非对象', () => {
    expect(() => decodeRelayCtl('{"t":"node.status"}')).toThrow(RelayCtlError);
    expect(() => decodeRelayCtl('[]')).toThrow(RelayCtlError);
    expect(() => decodeRelayCtl('not json')).toThrow(RelayCtlError);
  });

  it('拒绝错误长度的 b64url 字段', () => {
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({ t: 'auth.challenge', nonce: encodeBase64url(new Uint8Array(31)) })
      )
    ).toThrow(RelayCtlError);
    expect(() => decodeRelayCtl(JSON.stringify({ t: 'auth.challenge', nonce: '@@@@' }))).toThrow(
      RelayCtlError
    );
  });

  it('拒绝非法 node_id / tenant_id', () => {
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({ t: 'relay.rtc', rtcSession: 's', from: 'node', to: 'XY', enc: ENVELOPE })
      )
    ).toThrow(RelayCtlError);
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({ t: 'auth.ok', tenant_id: 'zz', key_log_head_seq: 1, rtc: RTC })
      )
    ).toThrow(RelayCtlError);
  });

  it('拒绝非法 from / status / reason 枚举', () => {
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({ t: 'relay.rtc', rtcSession: 's', from: 'hub', to: NODE_A, enc: ENVELOPE })
      )
    ).toThrow(RelayCtlError);
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({
          t: 'relay.list',
          version: 1,
          nodes: [{ id: NODE_A, online: true, status: 'ghost', direct_capable: true }],
          rtc: RTC,
          key_log_head_seq: 1,
        })
      )
    ).toThrow(RelayCtlError);
    expect(() => decodeRelayCtl(JSON.stringify({ t: 'relay.kicked', reason: 'because' }))).toThrow(
      RelayCtlError
    );
  });

  it('拒绝非法信封', () => {
    for (const blob of [
      { v: 2, n: ENVELOPE.n, ct: ENVELOPE.ct },
      { v: 1, n: encodeBase64url(new Uint8Array(11)), ct: ENVELOPE.ct },
      { v: 1, n: ENVELOPE.n },
      'nope',
    ]) {
      expect(() =>
        decodeRelayCtl(JSON.stringify({ t: 'relay.status', blob, epoch: 1, direct_capable: true }))
      ).toThrow(RelayCtlError);
    }
  });

  it('拒绝超量数组与超长帧', () => {
    const records = Array.from({ length: RELAY_KEYLOG_PAGE_MAX_LIMIT + 1 }, (_, i) => ({
      seq: i + 1,
      blob: ENVELOPE,
    }));
    expect(() => decodeRelayCtl(JSON.stringify({ t: 'relay.keylog.res', records }))).toThrow(
      RelayCtlError
    );
    const huge = 'a'.repeat(RELAY_CTL_MAX_BYTES + 10);
    expect(() =>
      decodeRelayCtl(JSON.stringify({ t: 'relay.enroll.ack', id: huge, ok: true }))
    ).toThrow(RelayCtlError);
  });

  it('拒绝超限 limit 与负数字段', () => {
    expect(() =>
      decodeRelayCtl(JSON.stringify({ t: 'relay.keylog.req', from_seq: 1, limit: 0 }))
    ).toThrow(RelayCtlError);
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({
          t: 'relay.keylog.req',
          from_seq: 1,
          limit: RELAY_KEYLOG_PAGE_MAX_LIMIT + 1,
        })
      )
    ).toThrow(RelayCtlError);
    expect(() =>
      decodeRelayCtl(
        JSON.stringify({ t: 'relay.status', blob: ENVELOPE, epoch: -1, direct_capable: true })
      )
    ).toThrow(RelayCtlError);
  });

  it('encode 同样校验', () => {
    expect(() => encodeRelayCtl({ t: 'relay.kicked', reason: 'nope' } as never)).toThrow(
      RelayCtlError
    );
  });
});

describe('seq 编解码', () => {
  it('小值走 number，大值走字符串', () => {
    expect(relaySeqToWire(5n)).toBe(5);
    expect(relaySeqToWire(2n ** 60n)).toBe((2n ** 60n).toString());
    expect(relaySeqFromWire(5)).toBe(5n);
    expect(relaySeqFromWire('1152921504606846976')).toBe(2n ** 60n);
  });

  it('拒绝负数与越界', () => {
    expect(() => relaySeqToWire(-1n)).toThrow(RelayCtlError);
    expect(() => relaySeqFromWire(-1)).toThrow(RelayCtlError);
    expect(() => relaySeqFromWire('99999999999999999999999')).toThrow(RelayCtlError);
    expect(() => relaySeqFromWire('abc')).toThrow(RelayCtlError);
  });
});
