import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import { paddedCtlJson } from './hub-test-helpers';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  UPLINK_CTL_MAX_BYTES,
  UplinkCtlError,
  decodeUplinkCtl,
  encodeUplinkCtl,
  seqFromWire,
  seqToWire,
} from './uplink-protocol';

function roundtrip(msg: Parameters<typeof encodeUplinkCtl>[0]) {
  return decodeUplinkCtl(
    encodeUplinkCtl(msg),
    msg.t === 'key.log.res' ? { allowKeyLogRes: true } : undefined
  );
}

describe('uplink-protocol', () => {
  test('encode/decode 已知 ctl 类型', () => {
    const nonce = encodeBase64url(randomBytes(32));
    expect(roundtrip({ t: 'auth.challenge', nonce })).toEqual({ t: 'auth.challenge', nonce });

    const sig = encodeBase64url(randomBytes(64));
    const nodeId = 'ab'.repeat(16);
    expect(roundtrip({ t: 'auth.response', node_id: nodeId, sig })).toEqual({
      t: 'auth.response',
      node_id: nodeId,
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
      hub: { nodeId: 'n1', publicUrl: 'https://hub.example' },
    });
    expect(list.t).toBe('node.list');
    if (list.t === 'node.list') {
      expect(list.version).toBe(3);
      expect(list.nodes).toHaveLength(1);
      expect(list.rtc.stun).toEqual(['stun:example']);
      expect(list.hub).toEqual({ nodeId: 'n1', publicUrl: 'https://hub.example' });
    }

    expect(roundtrip({ t: 'key.log.req', from_seq: 1 })).toEqual({ t: 'key.log.req', from_seq: 1 });
    expect(roundtrip({ t: 'key.log.req', from_seq: 1, limit: 256 })).toEqual({
      t: 'key.log.req',
      from_seq: 1,
      limit: 256,
    });
    const recBytes = encodeBase64url(new Uint8Array([1, 2, 3]));
    const recSig = encodeBase64url(randomBytes(64));
    const res = roundtrip({
      t: 'key.log.res',
      records: [{ seq: 1, bytes: recBytes, sig: recSig }],
      has_more: true,
      retry_after_ms: 6000,
    });
    expect(res.t).toBe('key.log.res');
    if (res.t === 'key.log.res') {
      expect(res.has_more).toBe(true);
      expect(res.retry_after_ms).toBe(6000);
    }

    expect(roundtrip({ t: 'key.log.append', bytes: recBytes, sig: recSig }).t).toBe(
      'key.log.append'
    );
    const appendWithId = roundtrip({
      t: 'key.log.append',
      bytes: recBytes,
      sig: recSig,
      id: 'req-1',
    });
    expect(appendWithId).toEqual({
      t: 'key.log.append',
      bytes: recBytes,
      sig: recSig,
      id: 'req-1',
    });
    expect(roundtrip({ t: 'key.log.ack', id: 'req-1', ok: true, seq: 4 })).toEqual({
      t: 'key.log.ack',
      id: 'req-1',
      ok: true,
      seq: 4,
    });
    expect(roundtrip({ t: 'key.log.ack', id: 'req-2', ok: false, error: 'seq_gap' })).toEqual({
      t: 'key.log.ack',
      id: 'req-2',
      ok: false,
      error: 'seq_gap',
    });

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
      roundtrip({
        t: 'enroll.redeemed',
        certificate: cert,
        cert_sig: certSig,
        enroll_pk: enrollPk,
        node_id: 'ab'.repeat(16),
        entry_sid: 'sid-1',
      })
    ).toEqual({
      t: 'enroll.redeemed',
      certificate: cert,
      cert_sig: certSig,
      enroll_pk: enrollPk,
      node_id: 'ab'.repeat(16),
      entry_sid: 'sid-1',
    });
    expect(() =>
      decodeUplinkCtl(
        JSON.stringify({
          t: 'enroll.redeemed',
          certificate: cert,
          cert_sig: certSig,
          enroll_pk: enrollPk,
          node_id: 'short',
        })
      )
    ).toThrow(UplinkCtlError);

    expect(
      roundtrip({
        t: 'enroll.redeemed',
        certificate: cert,
        cert_sig: certSig,
        enroll_pk: enrollPk,
        node_id: 'ab'.repeat(16),
        already_admitted: true,
      })
    ).toEqual({
      t: 'enroll.redeemed',
      certificate: cert,
      cert_sig: certSig,
      enroll_pk: enrollPk,
      node_id: 'ab'.repeat(16),
      already_admitted: true,
    });
  });

  test('auth.response.node_id must be 32 lowercase hex', () => {
    const sig = encodeBase64url(randomBytes(64));
    expect(() =>
      decodeUplinkCtl(JSON.stringify({ t: 'auth.response', node_id: 'abc', sig }))
    ).toThrow(UplinkCtlError);
    expect(() =>
      decodeUplinkCtl(JSON.stringify({ t: 'auth.response', node_id: 'AB'.repeat(16), sig }))
    ).toThrow(UplinkCtlError);
    expect(() =>
      decodeUplinkCtl(
        JSON.stringify({ t: 'auth.response', node_id: `ab${'0'.repeat(30)}\ninjected`, sig })
      )
    ).toThrow(UplinkCtlError);
    expect(() =>
      decodeUplinkCtl(JSON.stringify({ t: 'auth.response', node_id: `${'g'.repeat(32)}`, sig }))
    ).toThrow(UplinkCtlError);
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
    expect(() => seqFromWire(1.5)).toThrow(UplinkCtlError);
    expect(() => seqFromWire(Number.MAX_SAFE_INTEGER + 1)).toThrow(UplinkCtlError);
    expect(seqFromWire('18446744073709551615')).toBe(18446744073709551615n);
    expect(() => seqFromWire('18446744073709551616')).toThrow(UplinkCtlError);
    expect(() => seqFromWire('123456789012345678901')).toThrow(UplinkCtlError);
  });

  test('拒绝 oversized / deep JSON / 过长 string', () => {
    const huge = 'a'.repeat(65 * 1024);
    expect(() => decodeUplinkCtl(`{"t":"ping","x":"${huge}"}`)).toThrow(UplinkCtlError);

    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { k: deep };
    expect(() =>
      decodeUplinkCtl(
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: deep,
          endpoints: [],
        })
      )
    ).toThrow(UplinkCtlError);

    expect(() =>
      decodeUplinkCtl(
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: { blob: 'x'.repeat(4097) },
          endpoints: [],
        })
      )
    ).toThrow(UplinkCtlError);

    expect(() =>
      decodeUplinkCtl(
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: {},
          endpoints: Array.from({ length: 33 }, () => ({ host: '10.0.0.1' })),
        })
      )
    ).toThrow(UplinkCtlError);
  });

  test('hub inbound 拒绝 key.log.res 与 1 MiB 帧', () => {
    const smallRes = JSON.stringify({ t: 'key.log.res', records: [] });
    expect(() => decodeUplinkCtl(smallRes)).toThrow(UplinkCtlError);
    expect(() =>
      decodeUplinkCtl(paddedCtlJson({ t: 'key.log.res', records: [] }, KEY_LOG_PAGE_MAX_BYTES))
    ).toThrow(UplinkCtlError);
    expect(() => decodeUplinkCtl(paddedCtlJson({ t: 'ping' }, UPLINK_CTL_MAX_BYTES + 1))).toThrow(
      UplinkCtlError
    );
    const allowed = decodeUplinkCtl(smallRes, { allowKeyLogRes: true });
    expect(allowed.t).toBe('key.log.res');
  });
});
