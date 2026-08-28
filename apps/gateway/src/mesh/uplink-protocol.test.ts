import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_CERT_BYTES,
  decodeUplinkCtl,
  encodeUplinkCtl,
  uplinkWsUrl,
} from './uplink-protocol';

function paddedCtlJson(fields: Record<string, unknown>, size: number): string {
  const empty = JSON.stringify({ ...fields, pad: '' });
  const prefix = empty.slice(0, -2);
  const suffix = '"}';
  const padLen = size - prefix.length - suffix.length;
  if (padLen < 0) {
    throw new Error(`paddedCtlJson target ${size} is smaller than ${empty.length}`);
  }
  return `${prefix}${'x'.repeat(padLen)}${suffix}`;
}

describe('uplink-protocol', () => {
  test('round-trips auth, ping, status, and node.list with b64url binaries', () => {
    const nonce = randomBytes(32);
    const challenge = decodeUplinkCtl(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(nonce) })
    );
    expect(challenge).toEqual({ t: 'auth.challenge', nonce: encodeBase64url(nonce) });

    const hash = randomBytes(32);
    const recBytes = randomBytes(16);
    const recSig = randomBytes(64);
    const list = decodeUplinkCtl(
      encodeUplinkCtl({
        t: 'node.list',
        version: 3,
        key_log_head: { seq: 7n, hash },
        rtc: { stun: ['stun:example'], turn: null },
        nodes: [
          {
            id: 'aa'.repeat(16),
            name: 'node-a',
            online: true,
            endpoints: ['ws://127.0.0.1:39001/peer'],
            inventory: { devices: [] },
            direct_capable: false,
            version: '1.0.0',
          },
        ],
      })
    );
    expect(list.t).toBe('node.list');
    if (list.t !== 'node.list') throw new Error('expected node.list');
    expect(list.key_log_head.seq).toBe(7n);
    expect(list.nodes[0]?.name).toBe('node-a');
    expect(list.hub).toBeUndefined();

    const listed = decodeUplinkCtl(
      encodeUplinkCtl({
        t: 'node.list',
        version: 3,
        key_log_head: { seq: 7n, hash },
        rtc: { stun: ['stun:example'], turn: null },
        nodes: [],
        hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://hub.example', name: 'hub-site' },
      })
    );
    expect(listed.t).toBe('node.list');
    if (listed.t !== 'node.list') throw new Error('expected node.list');
    expect(listed.hub).toEqual({
      nodeId: 'aa'.repeat(16),
      publicUrl: 'https://hub.example',
      name: 'hub-site',
    });

    const hubWire = decodeUplinkCtl(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'node.list',
          version: 4,
          key_log_head: { seq: 2, hash: encodeBase64url(hash) },
          rtc: { stun: [], turn: null },
          hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://hub.example' },
          nodes: [
            {
              id: 'bb'.repeat(16),
              name: 'node-b',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: null,
            },
          ],
        })
      )
    );
    expect(hubWire.t).toBe('node.list');
    if (hubWire.t !== 'node.list') throw new Error('expected node.list');
    expect(hubWire.nodes[0]?.version).toBeNull();
    expect(hubWire.hub).toEqual({ nodeId: 'aa'.repeat(16), publicUrl: 'https://hub.example' });

    const res = decodeUplinkCtl(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 8n, bytes: recBytes, sig: recSig }],
        has_more: true,
      })
    );
    expect(res.t).toBe('key.log.res');
    if (res.t !== 'key.log.res') throw new Error('expected key.log.res');
    expect(res.records[0]?.seq).toBe(8n);
    expect(res.records[0]?.bytes).toEqual(recBytes);
    expect(res.has_more).toBe(true);

    const req = decodeUplinkCtl(
      encodeUplinkCtl({ t: 'key.log.req', from_seq: 2n, id: 'p1', limit: 256 })
    );
    expect(req).toEqual({ t: 'key.log.req', from_seq: 2n, id: 'p1', limit: 256 });

    const append = decodeUplinkCtl(
      encodeUplinkCtl({ t: 'key.log.append', bytes: recBytes, sig: recSig, id: 'ack-1' })
    );
    expect(append).toEqual({ t: 'key.log.append', bytes: recBytes, sig: recSig, id: 'ack-1' });
    const ackOk = decodeUplinkCtl(
      encodeUplinkCtl({ t: 'key.log.ack', id: 'ack-1', ok: true, seq: 9n })
    );
    expect(ackOk).toEqual({ t: 'key.log.ack', id: 'ack-1', ok: true, seq: 9n });
    const ackErr = decodeUplinkCtl(
      encodeUplinkCtl({ t: 'key.log.ack', id: 'ack-2', ok: false, error: 'seq_gap' })
    );
    expect(ackErr).toEqual({ t: 'key.log.ack', id: 'ack-2', ok: false, error: 'seq_gap' });

    const enrollPk = randomBytes(32);
    const cert = randomBytes(8);
    const certSig = randomBytes(64);
    const redeemed = decodeUplinkCtl(
      encodeUplinkCtl({
        t: 'enroll.redeemed',
        certificate: cert,
        cert_sig: certSig,
        enroll_pk: enrollPk,
        nodeId: 'bb'.repeat(16),
        entrySid: 'sid-creator',
      })
    );
    expect(redeemed).toEqual({
      t: 'enroll.redeemed',
      certificate: cert,
      cert_sig: certSig,
      enroll_pk: enrollPk,
      nodeId: 'bb'.repeat(16),
      entrySid: 'sid-creator',
    });
  });

  test('rejects enroll.redeemed field bounds and oversized ctl', () => {
    const enrollPk = randomBytes(32);
    const cert = randomBytes(8);
    const certSig = randomBytes(64);
    const nodeId = 'bb'.repeat(16);
    expect(() =>
      decodeUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'enroll.redeemed',
            certificate: encodeBase64url(cert),
            cert_sig: encodeBase64url(certSig),
            enroll_pk: encodeBase64url(randomBytes(16)),
            node_id: nodeId,
          })
        )
      )
    ).toThrow(/32 bytes/);
    expect(() =>
      decodeUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'enroll.redeemed',
            certificate: encodeBase64url(cert),
            cert_sig: encodeBase64url(randomBytes(32)),
            enroll_pk: encodeBase64url(enrollPk),
            node_id: nodeId,
          })
        )
      )
    ).toThrow(/64 bytes/);
    expect(() =>
      decodeUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'enroll.redeemed',
            certificate: encodeBase64url(cert),
            cert_sig: encodeBase64url(certSig),
            enroll_pk: encodeBase64url(enrollPk),
            node_id: 'not-a-node-id',
          })
        )
      )
    ).toThrow(/32-hex/);
    expect(() =>
      decodeUplinkCtl(
        new TextEncoder().encode(
          JSON.stringify({
            t: 'enroll.redeemed',
            certificate: encodeBase64url(new Uint8Array(UPLINK_CTL_MAX_CERT_BYTES + 1)),
            cert_sig: encodeBase64url(certSig),
            enroll_pk: encodeBase64url(enrollPk),
            node_id: nodeId,
          })
        )
      )
    ).toThrow(/too large/);
    expect(() => decodeUplinkCtl(new Uint8Array(65 * 1024))).toThrow(/too large/);
  });

  test('rejects unknown t', () => {
    expect(() => decodeUplinkCtl(new TextEncoder().encode(JSON.stringify({ t: 'nope' })))).toThrow(
      /unknown uplink ctl/
    );
  });

  test('1 MiB key.log.res 仅在存在匹配 pending id 时接受', () => {
    const id = 'pending-1';
    const huge = new TextEncoder().encode(
      paddedCtlJson({ t: 'key.log.res', records: [], id }, KEY_LOG_PAGE_MAX_BYTES)
    );
    expect(huge.byteLength).toBe(KEY_LOG_PAGE_MAX_BYTES);
    expect(() => decodeUplinkCtl(huge)).toThrow(/too large/);
    expect(() => decodeUplinkCtl(huge, { pendingKeyLogId: 'other' })).toThrow(/too large/);
    const accepted = decodeUplinkCtl(huge, { pendingKeyLogId: id });
    expect(accepted.t).toBe('key.log.res');
    if (accepted.t !== 'key.log.res') throw new Error('expected key.log.res');
    expect(accepted.id).toBe(id);
    expect(accepted.records).toEqual([]);

    const hugePing = new TextEncoder().encode(paddedCtlJson({ t: 'ping' }, KEY_LOG_PAGE_MAX_BYTES));
    expect(() => decodeUplinkCtl(hugePing, { pendingKeyLogId: id })).toThrow(/too large/);
    expect(() =>
      decodeUplinkCtl(
        new TextEncoder().encode(paddedCtlJson({ t: 'ping' }, UPLINK_CTL_MAX_BYTES + 1))
      )
    ).toThrow(/too large/);
  });

  test('maps http(s) hub url onto /hub/uplink', () => {
    expect(uplinkWsUrl('https://hub.example.com')).toBe('wss://hub.example.com/hub/uplink');
    expect(uplinkWsUrl('http://127.0.0.1:9883/foo')).toBe('ws://127.0.0.1:9883/hub/uplink');
  });
});
