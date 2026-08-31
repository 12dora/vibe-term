import { describe, expect, test } from 'bun:test';
import { DOMAIN_CERTIFICATE, encodeCertificate, hexToBytes } from '@tmex/shared/auth';
import {
  parseJson,
  pickMeshNodeName,
  projectMeshListNode,
  projectNode,
  upsertById,
  versionFromInventory,
} from './node-list-projection';

describe('node-list-projection', () => {
  test('projectNode prefers live inventory, capability, and version', () => {
    expect(
      projectNode(
        'n1',
        'box',
        true,
        {
          endpoints: ['old'],
          inventory: { version: '1' },
          directCapable: false,
          version: '1',
        },
        {
          endpoints: ['new'],
          inventory: { version: '2' },
          directCapable: true,
          version: '2',
        }
      )
    ).toEqual({
      id: 'n1',
      name: 'box',
      online: true,
      endpoints: ['new'],
      inventory: { version: '2' },
      direct_capable: true,
      version: '2',
    });
  });

  test('upsertById overwrites an existing hub row in place', () => {
    const nodes = [{ id: 'hub', name: 'old', online: false }];
    upsertById(nodes, { id: 'hub', name: 'site', online: true });
    upsertById(nodes, { id: 'peer', name: 'p', online: true });
    expect(nodes).toEqual([
      { id: 'hub', name: 'site', online: true },
      { id: 'peer', name: 'p', online: true },
    ]);
  });

  test('parseJson and versionFromInventory fall back cleanly', () => {
    expect(parseJson('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJson('nope', { x: 1 })).toEqual({ x: 1 });
    expect(parseJson(null, [])).toEqual([]);
    expect(versionFromInventory({ version: '9' })).toBe('9');
    expect(versionFromInventory({})).toBeNull();
  });

  test('pickMeshNodeName prefers listed then registry then self fallback', () => {
    expect(
      pickMeshNodeName({
        id: 'aa',
        isSelf: true,
        listedName: 'self',
        registryName: 'aa',
        selfName: 'home',
      })
    ).toBe('home');
    expect(pickMeshNodeName({ id: 'bb', isSelf: false, listedName: 'studio' })).toBe('studio');
  });

  test('wan reach is online and includes transport plus rttMs', () => {
    const selfId = 'aa'.repeat(16);
    const peerId = 'cc'.repeat(16);
    const dto = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'wan']]),
      new Set(),
      new Map([
        [
          peerId,
          {
            certificateBytes: encodeCertificate({
              domain: DOMAIN_CERTIFICATE,
              uid: 'user-1',
              node_id: hexToBytes(peerId),
              ed_pk: new Uint8Array(32).fill(4),
              x25519_pk: new Uint8Array(32).fill(5),
              enroll_pk: new Uint8Array(32).fill(6),
              issued_at: 1n,
            }),
          },
        ],
      ]),
      new Map([[peerId, { inventoryJson: '{}', directCapable: false }]]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      null,
      () => 'ws-secure',
      () => 80
    );
    expect(dto?.online).toBe(true);
    expect(dto?.reach).toBe('wan');
    expect(dto?.transport).toBe('ws-secure');
    expect(dto?.rttMs).toBe(80);
  });

  test('includes link diagnostics and leaves them empty for self', () => {
    const selfId = 'aa'.repeat(16);
    const peerId = 'cc'.repeat(16);
    const cert = {
      certificateBytes: encodeCertificate({
        domain: DOMAIN_CERTIFICATE,
        uid: 'user-1',
        node_id: hexToBytes(peerId),
        ed_pk: new Uint8Array(32).fill(4),
        x25519_pk: new Uint8Array(32).fill(5),
        enroll_pk: new Uint8Array(32).fill(6),
        issued_at: 1n,
      }),
    };
    const peerDto = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'relay']]),
      new Set(),
      new Map([[peerId, cert]]),
      new Map([
        [
          peerId,
          {
            inventoryJson: '{}',
            directCapable: false,
            endpointsJson: JSON.stringify(['ws://10.77.88.3:39001/peer']),
          },
        ],
      ]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      null,
      () => 'relay',
      () => 38,
      () => ({
        peerAddress: 'hub.example.com',
        linkSinceAt: 1_700_000_000_000,
        endpoints: ['ws://should.not.use.detail/peer'],
        directFailure: {
          at: 1_700_000_000_100,
          ws: 'timeout ws://10.77.88.3:39001/peer',
          dc: 'datachannel open timeout',
        },
      })
    );
    expect(peerDto?.endpoints).toEqual(['ws://10.77.88.3:39001/peer']);
    expect(peerDto?.directFailure).toEqual({
      at: 1_700_000_000_100,
      ws: 'timeout ws://10.77.88.3:39001/peer',
      dc: 'datachannel open timeout',
    });
    const selfDto = projectMeshListNode(
      selfId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      'home',
      { inventory: {}, direct_capable: false, version: '1' },
      null,
      () => 'relay',
      () => 1,
      () => ({
        peerAddress: 'should-not-leak',
        linkSinceAt: 9,
        endpoints: ['ws://10.0.0.1:1/peer'],
        directFailure: { at: 1, ws: 'x', dc: 'y' },
      })
    );
    expect(selfDto?.peerAddress).toBeNull();
    expect(selfDto?.linkSinceAt).toBeNull();
    expect(selfDto?.endpoints).toEqual([]);
    expect(selfDto?.directFailure).toBeNull();
  });
});
