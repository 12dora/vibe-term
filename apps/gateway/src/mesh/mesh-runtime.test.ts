import { afterEach, describe, expect, test } from 'bun:test';
import { UserStore } from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
import { GatewaySession } from '../ws/gateway-session';
import { createFakeCarrier } from '../ws/test-helpers';
import {
  SessionRegistry,
  attachKeyLogHeadNotify,
  createKeyLogPublisher,
  createMeshRuntime,
  createTtlCache,
  enumeratePeerEndpoints,
  isAdvertisablePeerAddress,
} from './mesh-runtime';
import { RelaySecondaryAttach } from './relay-secondary-attach';
import { fakeSocketPair, seedUser } from './test-support';

function fakeGateway(db: AuthDb): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async () => new Response('not-found', { status: 404 }),
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

describe('createMeshRuntime', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('node with no set-relays starts an idle uplink (no ws factory, no candidates)', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
    let wsCalls = 0;
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { node: true, relay: false },
        peerPort: 0,
        stunServers: [],
      },
      wsFactory: () => {
        wsCalls += 1;
        return fakeSocketPair()[0];
      },
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(wsCalls).toBe(0);
    expect(mesh.uplink.candidates()).toEqual([]);
    expect(mesh.uplink.liveClient()).toBeNull();
    expect(mesh.uplink.state).toBe('offline');
    expect(mesh.peers.listenPort).toBeGreaterThan(0);
  });

  test('UplinkPool 与 RelaySecondaryAttach 共享同一个 UplinkDialCoordinator', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: { roles: { node: true, relay: false }, peerPort: 0, stunServers: [] },
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(mesh.relayOpener).toBeInstanceOf(RelaySecondaryAttach);
    const opener = mesh.relayOpener as RelaySecondaryAttach;
    expect(opener.dialCoordinator).toBe(mesh.uplink.dialCoordinator);
  });

  test('两个 mesh runtime 不共享 UplinkDialCoordinator', async () => {
    const a = createMigratedAuthDb();
    const b = createMigratedAuthDb();
    seedUser(new UserStore(a.db));
    seedUser(new UserStore(b.db));
    const meshA = await createMeshRuntime({
      db: a.db,
      gateway: fakeGateway(a.db),
      config: { roles: { node: true, relay: false }, peerPort: 0, stunServers: [] },
    });
    const meshB = await createMeshRuntime({
      db: b.db,
      gateway: fakeGateway(b.db),
      config: { roles: { node: true, relay: false }, peerPort: 0, stunServers: [] },
    });
    fixtures.push({ close: a.close, stop: () => meshA.stop() });
    fixtures.push({ close: b.close, stop: () => meshB.stop() });
    expect(meshA.uplink.dialCoordinator).not.toBe(meshB.uplink.dialCoordinator);
  });

  test('MeshRuntimeConfig.peerBindHost is threaded to PeerServer when peerHostname is omitted', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { node: true, relay: false },
        peerPort: 0,
        stunServers: [],
        peerBindHost: ['127.0.0.1'],
      },
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    const port = mesh.peers.listenPort;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/peer`);
    expect(res.status).toBe(426);
    await expect(fetch(`http://[::1]:${port}/peer`)).rejects.toThrow();
  });

  test('does not start uplink when users/certs are empty or ambiguous', async () => {
    const { db, close } = createMigratedAuthDb();
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { node: true, relay: false },
        peerPort: 0,
        stunServers: [],
      },
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    expect(mesh.uplink.state).toBe('offline');
    expect(mesh.uplink.liveClient()).toBeNull();
  });
});

describe('SessionRegistry', () => {
  test('keys connections independently so two tabs with the same sid do not clobber', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    expect(
      registry.register({
        connectionId: 'conn-a',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: a,
      }).ok
    ).toBe(true);
    expect(
      registry.register({
        connectionId: 'conn-b',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: b,
      }).ok
    ).toBe(true);
    expect(registry.get('sid-1')).toBeNull();
    expect(registry.getByConnectionId('conn-a')?.session).toBe(a);
    expect(registry.getByConnectionId('conn-b')?.session).toBe(b);
    expect(registry.lookup('sid-1', 'self')).toEqual({
      ok: false,
      code: 'MULTIPLE_CONNECTIONS',
    });
    expect(registry.lookup('sid-1', 'self', 'conn-a')).toEqual({
      ok: true,
      connectionId: 'conn-a',
    });
    registry.unregisterSession(a);
    expect(registry.getByConnectionId('conn-a')).toBeNull();
    expect(registry.get('sid-1')?.session).toBe(b);
  });

  test('generates a server connectionId and maps cid scoped to sid+via', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const first = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'nonce-a',
      session: a,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');
    expect(first.entry.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.entry.connectionId).not.toBe('nonce-a');
    expect(first.entry.connectionId).not.toBe(a.id);
    expect(registry.lookup('sid-1', 'self', null, 'nonce-a')).toEqual({
      ok: true,
      connectionId: first.entry.connectionId,
    });
    expect(registry.lookup('sid-1', 'other', null, 'nonce-a')).toEqual({
      ok: false,
      code: 'NO_CONNECTION',
    });
  });

  test('rejects a duplicate connectionId and keeps the previous session', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    expect(
      registry.register({
        connectionId: 'fixed-id',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: a,
      }).ok
    ).toBe(true);
    const dup = registry.register({
      connectionId: 'fixed-id',
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      session: b,
    });
    expect(dup).toEqual({ ok: false, code: 'DUPLICATE_CONNECTION' });
    expect(registry.getByConnectionId('fixed-id')?.session).toBe(a);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
  });

  test('rejects a duplicate cid in the same sid+via scope', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    const first = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'same-nonce',
      session: a,
    });
    expect(first.ok).toBe(true);
    const dup = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'same-nonce',
      session: b,
    });
    expect(dup).toEqual({ ok: false, code: 'DUPLICATE_CID' });
    if (!first.ok) throw new Error('expected ok');
    expect(registry.getByConnectionId(first.entry.connectionId)?.session).toBe(a);
  });
});

describe('isAdvertisablePeerAddress', () => {
  const ni = (address: string, family: string | number, internal = false) =>
    ({
      address,
      netmask: family === 'IPv6' || family === 6 ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
      family,
      mac: '',
      internal,
      cidr: null,
      scopeid: 0,
    }) as Parameters<typeof isAdvertisablePeerAddress>[0];

  test('pins current accept and reject cases', () => {
    const accept: Array<[string, string | number]> = [
      ['10.0.0.12', 'IPv4'],
      ['192.0.2.10', 4],
      ['192.168.1.1', 'IPv4'],
      ['172.28.0.4', 'IPv4'],
      ['223.255.255.255', 'IPv4'],
      ['2001:db8::8', 'IPv6'],
      ['2001:db8::8%eth0', 'IPv6'],
      ['2001:db8::8', 6],
      ['2600::1', 'IPv6'],
      ['fe7f::1', 'IPv6'],
      ['::2', 'IPv6'],
      ['198.17.255.255', 'IPv4'],
      ['198.20.0.1', 'IPv4'],
    ];
    const reject: Array<[string, string | number, boolean?]> = [
      ['10.0.0.12', 'IPv4', true],
      ['127.0.0.1', 'IPv4'],
      ['127.1.2.3', 'IPv4'],
      ['169.254.10.20', 'IPv4'],
      ['0.0.0.0', 'IPv4'],
      ['0.1.2.3', 'IPv4'],
      ['224.0.0.1', 'IPv4'],
      ['240.0.0.1', 'IPv4'],
      ['255.255.255.255', 'IPv4'],
      ['239.255.255.255', 'IPv4'],
      ['256.0.0.1', 'IPv4'],
      ['10.0.0', 'IPv4'],
      ['1.2.3.4.5', 'IPv4'],
      ['not-an-ip', 'IPv4'],
      ['2001:db8::8', 'IPX'],
      ['fe80::1', 'IPv6'],
      ['fe80::1%en0', 'IPv6'],
      ['febf::1', 'IPv6'],
      ['ff02::1', 'IPv6'],
      ['ff00::1', 'IPv6'],
      ['::', 'IPv6'],
      ['::1', 'IPv6'],
      ['::1', 6],
      [':::1', 'IPv6'],
      ['2001:db8::1.2.3.4', 'IPv6'],
      ['fec0::1', 'IPv6'],
      ['fc00::1', 'IPv6'],
      ['fd12:3456:789a::1', 'IPv6'],
      ['100.64.0.1', 'IPv4'],
      ['100.127.255.255', 'IPv4'],
      ['198.18.0.0', 'IPv4'],
      ['198.18.0.1', 'IPv4'],
      ['198.19.255.255', 'IPv4'],
    ];
    for (const [address, family] of accept) {
      expect(isAdvertisablePeerAddress(ni(address, family)), `${family} ${address}`).toBe(true);
    }
    for (const [address, family, internal] of reject) {
      expect(
        isAdvertisablePeerAddress(ni(address, family, Boolean(internal))),
        `${family} ${address}${internal ? ' internal' : ''}`
      ).toBe(false);
    }
  });

  test('skips container-oriented interfaces even for RFC1918', () => {
    expect(isAdvertisablePeerAddress(ni('172.17.0.1', 'IPv4'), { iface: 'docker0' })).toBe(false);
    expect(isAdvertisablePeerAddress(ni('10.0.0.12', 'IPv4'), { iface: 'vethabc' })).toBe(false);
    expect(isAdvertisablePeerAddress(ni('10.0.0.12', 'IPv4'), { iface: 'br-1a2b' })).toBe(false);
    expect(isAdvertisablePeerAddress(ni('10.0.0.12', 'IPv4'), { iface: 'en0' })).toBe(true);
    expect(isAdvertisablePeerAddress(ni('10.0.0.12', 'IPv4'), { iface: 'utun4' })).toBe(true);
  });

  test('CGNAT is rejected unless allowCgnat is set', () => {
    expect(isAdvertisablePeerAddress(ni('100.64.1.1', 'IPv4'))).toBe(false);
    expect(isAdvertisablePeerAddress(ni('100.64.1.1', 'IPv4'), { allowCgnat: true })).toBe(true);
    expect(
      isAdvertisablePeerAddress(ni('100.64.1.1', 'IPv4'), { iface: 'utun0', allowCgnat: true })
    ).toBe(true);
  });

  test('rejects RFC 2544 fake-IP even on utun or with allowCgnat', () => {
    expect(isAdvertisablePeerAddress(ni('198.18.0.1', 'IPv4'))).toBe(false);
    expect(isAdvertisablePeerAddress(ni('198.19.1.2', 'IPv4'), { iface: 'utun4' })).toBe(false);
    expect(isAdvertisablePeerAddress(ni('198.18.0.1', 'IPv4'), { allowCgnat: true })).toBe(false);
    const urls = enumeratePeerEndpoints(39001, {
      en0: [ni('10.0.0.12', 'IPv4')],
      utun4: [ni('198.18.0.1', 'IPv4')],
    });
    expect(urls).toEqual(['ws://10.0.0.12:39001/peer']);
  });
});

describe('key-log head notify wiring', () => {
  const record = { bytes: new Uint8Array([1]), sig: new Uint8Array([2]) };

  test('attachKeyLogHeadNotify 仅在 apply 成功后通知', async () => {
    const calls: string[] = [];
    const apply = attachKeyLogHeadNotify(
      async () => {
        calls.push('apply');
        return { ok: true as const, seq: 4, hash: new Uint8Array(32), effects: [] };
      },
      () => {
        calls.push('notify');
      }
    );
    await apply('user-1', record);
    expect(calls).toEqual(['apply', 'notify']);
  });

  test('attachKeyLogHeadNotify apply 失败不通知', async () => {
    let notified = 0;
    const apply = attachKeyLogHeadNotify(
      async () => ({ ok: false as const, error: 'fork' }),
      () => {
        notified += 1;
      }
    );
    const result = await apply('user-1', record);
    expect(result).toEqual({ ok: false, error: 'fork' });
    expect(notified).toBe(0);
  });

  test('publishAndAck 在 ACK 后不通知（等本地 apply）', async () => {
    let notified = 0;
    const publisher = createKeyLogPublisher(
      {
        sendCtl() {},
        async appendAndAck() {
          return { ok: true, seq: 3n };
        },
        async queryKeyLogHead() {
          return null;
        },
        async queryKeyLogAt() {
          return null;
        },
      },
      () => {
        notified += 1;
      }
    );
    const ack = await publisher.publishAndAck?.(record);
    expect(ack).toEqual({ ok: true, seq: 3n });
    expect(notified).toBe(0);
  });

  test('publish 仍在本地 apply 之后的 fan-out 路径通知', () => {
    let notified = 0;
    const publisher = createKeyLogPublisher(
      {
        sendCtl() {},
        async appendAndAck() {
          return { ok: false, error: 'unused' };
        },
        async queryKeyLogHead() {
          return null;
        },
        async queryKeyLogAt() {
          return null;
        },
      },
      () => {
        notified += 1;
      }
    );
    publisher.publish(record);
    expect(notified).toBe(1);
  });

  test('createKeyLogPublisher 只向传入的 uplink（primary 池）发布', async () => {
    const calls: string[] = [];
    const publisher = createKeyLogPublisher(
      {
        sendCtl(msg) {
          calls.push(`sendCtl:${msg.t}`);
        },
        async appendAndAck() {
          calls.push('appendAndAck');
          return { ok: true, seq: 4n };
        },
        async queryKeyLogHead() {
          return null;
        },
        async queryKeyLogAt() {
          return null;
        },
      },
      () => {}
    );
    publisher.publish(record);
    const ack = await publisher.publishAndAck?.(record);
    expect(ack).toEqual({ ok: true, seq: 4n });
    expect(calls).toEqual(['sendCtl:key.log.append', 'appendAndAck']);
  });
});

describe('createTtlCache', () => {
  test('coalesces reads within TTL and refreshes after invalidate or expiry', () => {
    let now = 0;
    let generation = 1;
    const cache = createTtlCache(
      () => generation,
      8_000,
      () => now
    );
    expect(cache.get()).toBe(1);
    generation = 2;
    now = 7_999;
    expect(cache.get()).toBe(1);
    cache.invalidate();
    expect(cache.get()).toBe(2);
    generation = 3;
    now = 8_000;
    expect(cache.get()).toBe(2);
    now = 16_000;
    expect(cache.get()).toBe(3);
    generation = 4;
    expect(cache.refresh()).toBe(4);
    expect(cache.get()).toBe(4);
  });
});
