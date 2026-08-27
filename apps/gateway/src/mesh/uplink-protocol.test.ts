import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import { decodeUplinkCtl, encodeUplinkCtl, uplinkWsUrl } from './uplink-protocol';

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

    const res = decodeUplinkCtl(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 8n, bytes: recBytes, sig: recSig }],
      })
    );
    expect(res.t).toBe('key.log.res');
    if (res.t !== 'key.log.res') throw new Error('expected key.log.res');
    expect(res.records[0]?.seq).toBe(8n);
    expect(res.records[0]?.bytes).toEqual(recBytes);
  });

  test('rejects unknown t', () => {
    expect(() => decodeUplinkCtl(new TextEncoder().encode(JSON.stringify({ t: 'nope' })))).toThrow(
      /unknown uplink ctl/
    );
  });

  test('maps http(s) hub url onto /hub/uplink', () => {
    expect(uplinkWsUrl('https://hub.example.com')).toBe('wss://hub.example.com/hub/uplink');
    expect(uplinkWsUrl('http://127.0.0.1:9883/foo')).toBe('ws://127.0.0.1:9883/hub/uplink');
  });
});
