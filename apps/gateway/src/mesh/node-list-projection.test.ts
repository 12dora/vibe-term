import { describe, expect, test } from 'bun:test';
import {
  DOMAIN_CERTIFICATE,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
} from '@vibeterm/shared/auth';
import {
  meshListReadiness,
  overlayPausedMeshNodes,
  parseJson,
  pickMeshNodeName,
  pickSelfDisplayName,
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
    expect(projectNode('n1', 'box', true, { version: '1' }, null)).toEqual({
      id: 'n1',
      name: 'box',
      online: true,
      endpoints: [],
      inventory: null,
      direct_capable: false,
      version: '1',
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

  test('pickSelfDisplayName order is listed → registry → identity → site', () => {
    const id = 'aa'.repeat(16);
    expect(
      pickSelfDisplayName({
        id,
        listedName: 'listed',
        registryName: 'registry',
        identityName: 'identity',
        siteName: 'site',
      })
    ).toBe('listed');
    expect(
      pickSelfDisplayName({
        id,
        listedName: 'self',
        registryName: 'registry',
        identityName: 'identity',
        siteName: 'site',
      })
    ).toBe('registry');
    expect(
      pickSelfDisplayName({
        id,
        listedName: id,
        registryName: '  ',
        identityName: 'identity',
        siteName: 'site',
      })
    ).toBe('identity');
    expect(
      pickSelfDisplayName({
        id,
        listedName: 'self',
        registryName: id,
        identityName: null,
        siteName: 'studio',
      })
    ).toBe('studio');
    expect(pickSelfDisplayName({ id, listedName: 'self', siteName: id })).toBeNull();
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
      () => 'ws-secure',
      () => 80
    );
    expect(dto?.online).toBe(true);
    expect(dto?.reach).toBe('wan');
    expect(dto?.transport).toBe('ws-secure');
    expect(dto?.rttMs).toBe(80);
    expect(dto?.viaRelay).toBeUndefined();
    expect(dto?.relayPresence).toBeUndefined();
  });

  test('relay transport projects viaRelay and relayPresence; ws omits viaRelay', () => {
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
    const dto = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'relay']]),
      new Set(),
      new Map([[peerId, cert]]),
      new Map([[peerId, { inventoryJson: '{}', directCapable: false }]]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      () => 'relay',
      () => 90,
      () => ({
        peerAddress: 'sh.example',
        linkSinceAt: 1,
        endpoints: [],
        directFailure: null,
        viaRelay: 'https://from-detail.example',
        relayPresence: ['https://ignored-detail.example'],
      }),
      () => 'https://sh.example',
      () => ['https://sh.example', 'https://ty.example']
    );
    expect(dto?.transport).toBe('relay');
    expect(dto?.viaRelay).toBe('https://sh.example');
    expect(dto?.relayPresence).toEqual(['https://sh.example', 'https://ty.example']);

    const fromDetail = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'relay']]),
      new Set(),
      new Map([[peerId, cert]]),
      new Map(),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      () => 'relay',
      () => 12,
      () => ({
        peerAddress: null,
        linkSinceAt: 1,
        endpoints: [],
        directFailure: null,
        viaRelay: 'https://ty.example',
        relayPresence: ['https://ty.example'],
      })
    );
    expect(fromDetail?.viaRelay).toBe('https://ty.example');
    expect(fromDetail?.relayPresence).toEqual(['https://ty.example']);

    const ws = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'lan']]),
      new Set(),
      new Map([[peerId, cert]]),
      new Map(),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      () => 'ws-secure',
      () => 8,
      undefined,
      () => 'https://should-omit.example',
      () => []
    );
    expect(ws?.viaRelay).toBeUndefined();
    expect(ws?.relayPresence).toEqual([]);
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
            endpointsJson: JSON.stringify(['ws://10.110.88.3:39001/peer']),
          },
        ],
      ]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      () => 'relay',
      () => 38,
      () => ({
        peerAddress: 'hub.example.com',
        linkSinceAt: 1_700_000_000_000,
        endpoints: ['ws://should.not.use.detail/peer'],
        directFailure: {
          at: 1_700_000_000_100,
          ws: 'timeout ws://10.110.88.3:39001/peer',
          dc: 'datachannel open timeout',
        },
        dcBreaker: {
          cooling: true,
          until: 1_700_000_030_000,
          failures: 3,
          level: 1,
          lastFailureKind: 'timeout',
        },
      })
    );
    expect(peerDto?.endpoints).toEqual(['ws://10.110.88.3:39001/peer']);
    expect(peerDto?.directFailure).toEqual({
      at: 1_700_000_000_100,
      ws: 'timeout ws://10.110.88.3:39001/peer',
      dc: 'datachannel open timeout',
    });
    expect(peerDto?.dcBreaker).toEqual({
      cooling: true,
      until: 1_700_000_030_000,
      failures: 3,
      level: 1,
      lastFailureKind: 'timeout',
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
    expect(selfDto?.dcBreaker).toBeNull();
    expect(selfDto?.lastSeenAt).toBeNull();
  });

  test('lastSeenAt 来自 peer_cache；self 恒为 null', () => {
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
    const seen = 1_700_000_222_000;
    const peerDto = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map([[peerId, 'lan']]),
      new Set(),
      new Map([[peerId, cert]]),
      new Map([[peerId, { inventoryJson: '{}', directCapable: false, lastSeenAt: seen }]]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined
    );
    expect(peerDto?.lastSeenAt).toBe(seen);

    const missing = projectMeshListNode(
      peerId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map(),
      new Set(),
      new Map([[peerId, cert]]),
      new Map([[peerId, { inventoryJson: '{}', directCapable: false }]]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined
    );
    expect(missing?.lastSeenAt).toBeNull();

    const selfDto = projectMeshListNode(
      selfId,
      selfId,
      new Uint8Array(32).fill(1),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
      new Map([[selfId, { inventoryJson: '{}', lastSeenAt: seen }]]),
      new Map(),
      new Map(),
      'home',
      { inventory: {}, direct_capable: false, version: '1' }
    );
    expect(selfDto?.lastSeenAt).toBeNull();
  });

  test('overlayPausedMeshNodes marks paused members and never self', () => {
    const selfId = 'aa'.repeat(16);
    const peerId = 'bb'.repeat(16);
    const rows = overlayPausedMeshNodes(
      [
        {
          id: selfId,
          name: 'home',
          publicKey: 'pk',
          online: true,
          reach: null,
          transport: null,
          rttMs: null,
          version: null,
          direct_capable: false,
          inventory: null,
          loggedIn: true,
        },
        {
          id: peerId,
          name: 'studio',
          publicKey: 'pk2',
          online: true,
          reach: 'lan',
          transport: 'dc',
          rttMs: 1,
          version: '1',
          direct_capable: true,
          inventory: null,
          loggedIn: false,
        },
      ],
      selfId,
      new Set([selfId, peerId])
    );
    expect(rows[0]?.paused).toBeUndefined();
    expect(rows[1]?.paused).toBe(true);
  });

  test('projectMeshListNode full row JSON is byte-stable', () => {
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
    const dto = projectMeshListNode(
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
            inventoryJson: JSON.stringify({ version: '2.3.7', os: 'darwin' }),
            directCapable: true,
            endpointsJson: JSON.stringify(['ws://10.110.88.3:39001/peer']),
            lastSeenAt: 1_700_000_222_000,
          },
        ],
      ]),
      new Map([[peerId, 'studio']]),
      new Map(),
      null,
      undefined,
      () => 'relay',
      () => 38,
      () => ({
        peerAddress: 'hub.example.com',
        linkSinceAt: 1_700_000_000_000,
        endpoints: ['ws://should.not.use.detail/peer'],
        directFailure: {
          at: 1_700_000_000_100,
          ws: 'timeout ws://10.110.88.3:39001/peer',
          wsCode: 'timeout',
          wsParams: { url: 'ws://10.110.88.3:39001/peer', seconds: 8 },
          dc: 'datachannel open timeout',
          dcCode: 'dc_open_timeout',
          dcParams: { until: 1_700_000_030_000 },
        },
        dcBreaker: {
          cooling: true,
          until: 1_700_000_030_000,
          failures: 3,
          level: 1,
          lastFailureKind: 'timeout',
        },
        viaRelay: 'https://from-detail.example',
        relayPresence: ['https://ignored-detail.example'],
      }),
      () => 'https://sh.example',
      () => ['https://sh.example', 'https://ty.example']
    );
    const expected = {
      id: peerId,
      name: 'studio',
      publicKey: encodeBase64url(new Uint8Array(32).fill(4)),
      online: true,
      reach: 'relay',
      transport: 'relay',
      rttMs: 38,
      version: '2.3.7',
      direct_capable: true,
      inventory: { version: '2.3.7', os: 'darwin' },
      loggedIn: false,
      peerAddress: 'hub.example.com',
      linkSinceAt: 1_700_000_000_000,
      endpoints: ['ws://10.110.88.3:39001/peer'],
      directFailure: {
        at: 1_700_000_000_100,
        ws: 'timeout ws://10.110.88.3:39001/peer',
        wsCode: 'timeout',
        wsParams: { url: 'ws://10.110.88.3:39001/peer', seconds: 8 },
        dc: 'datachannel open timeout',
        dcCode: 'dc_open_timeout',
        dcParams: { until: 1_700_000_030_000 },
      },
      dcBreaker: {
        cooling: true,
        until: 1_700_000_030_000,
        failures: 3,
        level: 1,
        lastFailureKind: 'timeout',
      },
      viaRelay: 'https://sh.example',
      relayPresence: ['https://sh.example', 'https://ty.example'],
      lastSeenAt: 1_700_000_222_000,
    };
    expect(JSON.stringify(dto)).toBe(JSON.stringify(expected));
  });
});

describe('meshListReadiness', () => {
  const store = (
    peers: { nodeId: string; listVersion: number }[],
    certs: { nodeId: string; revokedLogSeq: number | null }[]
  ) => ({ listPeers: () => peers, listCerts: () => certs });
  const online = (...ids: string[]) => ids.map((id) => ({ id, online: true }));
  const offline = (...ids: string[]) => ids.map((id) => ({ id, online: false }));

  test('已应用但是空列表（单节点租户）：本地残留的证书按离线渲染，不再永远同步中', () => {
    expect(
      meshListReadiness(store([], [{ nodeId: 'c', revokedLogSeq: null }]), 'self', online('c'), [])
    ).toEqual({ listVersion: 0, pendingMembers: 0, pendingMemberIds: [] });
  });

  test('本进程还没应用过成员列表：证书有、peer_cache 没有的成员都算同步中', () => {
    expect(
      meshListReadiness(
        store(
          [{ nodeId: 'b', listVersion: 7 }],
          [
            { nodeId: 'self', revokedLogSeq: null },
            { nodeId: 'b', revokedLogSeq: null },
            { nodeId: 'c', revokedLogSeq: null },
          ]
        ),
        'self',
        offline('self', 'b', 'c'),
        null
      )
    ).toEqual({ listVersion: 7, pendingMembers: 1, pendingMemberIds: ['c'] });
  });

  test('列表已应用且成员离线：状态块永远不会来，按离线渲染而不是一直同步中', () => {
    expect(
      meshListReadiness(
        store([], [{ nodeId: 'c', revokedLogSeq: null }]),
        'self',
        [...offline('c'), ...online('self')],
        [{ id: 'c' }]
      )
    ).toEqual({ listVersion: 0, pendingMembers: 0, pendingMemberIds: [] });
  });

  test('列表已应用但成员不在列表里（已离开中继）：同样不算同步中', () => {
    expect(
      meshListReadiness(store([], [{ nodeId: 'c', revokedLogSeq: null }]), 'self', online('c'), [
        { id: 'other' },
      ]).pendingMembers
    ).toBe(0);
  });

  test('列表已应用、成员在线但状态块还没解开：仍算同步中', () => {
    expect(
      meshListReadiness(store([], [{ nodeId: 'c', revokedLogSeq: null }]), 'self', online('c'), [
        { id: 'c' },
      ])
    ).toEqual({ listVersion: 0, pendingMembers: 1, pendingMemberIds: ['c'] });
  });

  test('本机与已吊销的证书不计入待同步', () => {
    expect(
      meshListReadiness(
        store(
          [],
          [
            { nodeId: 'self', revokedLogSeq: null },
            { nodeId: 'gone', revokedLogSeq: 12 },
          ]
        ),
        'self',
        online('self', 'gone'),
        null
      )
    ).toEqual({ listVersion: 0, pendingMembers: 0, pendingMemberIds: [] });
  });

  test('listVersion 取 peer_cache 里的最高版本', () => {
    expect(
      meshListReadiness(
        store(
          [
            { nodeId: 'b', listVersion: 3 },
            { nodeId: 'c', listVersion: 9 },
          ],
          [
            { nodeId: 'b', revokedLogSeq: null },
            { nodeId: 'c', revokedLogSeq: null },
          ]
        ),
        'self',
        online('b', 'c'),
        null
      )
    ).toEqual({ listVersion: 9, pendingMembers: 0, pendingMemberIds: [] });
  });
});
