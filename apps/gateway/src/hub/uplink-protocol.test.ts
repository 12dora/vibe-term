import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import {
  UplinkCtlError,
  decodeUplinkCtl,
  encodeUplinkCtl,
  seqFromWire,
  seqToWire,
} from './uplink-protocol';

function roundtrip(msg: Parameters<typeof encodeUplinkCtl>[0]) {
  return decodeUplinkCtl(encodeUplinkCtl(msg));
}

describe('uplink-protocol', () => {
  test('encode/decode 已知 ctl 类型', () => {
    const nonce = encodeBase64url(randomBytes(32));
    expect(roundtrip({ t: 'auth.challenge', nonce })).toEqual({ t: 'auth.challenge', nonce });

    const sig = encodeBase64url(randomBytes(64));
    expect(roundtrip({ t: 'auth.response', node_id: 'abc', sig })).toEqual({
      t: 'auth.response',
      node_id: 'abc',
      sig,
    });
    expect(roundtrip({ t: 'auth.ok' })).toEqual({ t: 'auth.ok' });
    expect(roundtrip({ t: 'ping' })).toEqual({ t: 'ping' });
    expect(roundtrip({ t: 'pong' })).toEqual({ t: 'pong' });

    const status = roundtrip({
      t: 'node.status',
      version: '1.0.0',
      tmux: true,
      direct_capable: false,
      inventory: { devices: [] },
      endpoints: [{ host: '10.0.0.1' }],
    });
    expect(status.t).toBe('node.status');
    if (status.t === 'node.status') {
      expect(status.tmux).toBe(true);
      expect(status.inventory).toEqual({ devices: [] });
    }

    const hash = encodeBase64url(new Uint8Array(32));
    const list = roundtrip({
      t: 'node.list',
      version: 3,
      key_log_head: { seq: 2, hash },
      rtc: { stun: ['stun:example'], turn: null },
      nodes: [
        {
          id: 'n1',
          name: 'hub',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: true,
          version: '1',
        },
      ],
    });
    expect(list.t).toBe('node.list');
    if (list.t === 'node.list') {
      expect(list.version).toBe(3);
      expect(list.nodes).toHaveLength(1);
      expect(list.rtc.stun).toEqual(['stun:example']);
    }

    expect(roundtrip({ t: 'key.log.req', from_seq: 1 })).toEqual({ t: 'key.log.req', from_seq: 1 });
    const recBytes = encodeBase64url(new Uint8Array([1, 2, 3]));
    const recSig = encodeBase64url(randomBytes(64));
    const res = roundtrip({
      t: 'key.log.res',
      records: [{ seq: 1, bytes: recBytes, sig: recSig }],
    });
    expect(res.t).toBe('key.log.res');

    expect(roundtrip({ t: 'key.log.append', bytes: recBytes, sig: recSig }).t).toBe(
      'key.log.append'
    );

    const rtc = roundtrip({
      t: 'rtc.signal',
      rtcSession: 's1',
      from: 'browser',
      to: 'node-b',
      sdp: 'v=0',
    });
    expect(rtc).toEqual({
      t: 'rtc.signal',
      rtcSession: 's1',
      from: 'browser',
      to: 'node-b',
      sdp: 'v=0',
    });

    const enrollPk = encodeBase64url(randomBytes(32));
    const cert = encodeBase64url(new Uint8Array([9, 9]));
    const certSig = encodeBase64url(randomBytes(64));
    expect(
      roundtrip({ t: 'enroll.redeemed', certificate: cert, cert_sig: certSig, enroll_pk: enrollPk })
        .t
    ).toBe('enroll.redeemed');
  });

  test('拒绝 unknown t 与畸形字段', () => {
    expect(() => decodeUplinkCtl('{"t":"nope"}')).toThrow(UplinkCtlError);
    expect(() => decodeUplinkCtl('{"t":"auth.challenge","nonce":"aa"}')).toThrow(UplinkCtlError);
    expect(() => decodeUplinkCtl('{')).toThrow(UplinkCtlError);
    expect(() => decodeUplinkCtl('[]')).toThrow(UplinkCtlError);
  });

  test('seq 线格式 number / string', () => {
    expect(seqToWire(3n)).toBe(3);
    expect(seqFromWire(3)).toBe(3n);
    expect(seqFromWire('9')).toBe(9n);
    expect(() => seqFromWire(-1)).toThrow(UplinkCtlError);
  });
});
