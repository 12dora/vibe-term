import { afterEach, describe, expect, test } from 'bun:test';
import {
  decodeBase64url,
  encodeBase64url,
  generateEd25519KeyPair,
  hubHostFromUrl,
  randomBytes,
  uplinkAuthMessage,
  verifyEd25519,
} from '@tmex/shared/auth';
import { WebSocketLink } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { ImmediateScheduler, fakeSocketPair, seedUser, waitUntil } from './test-support';
import type { KeyLogApplier, UplinkStatus } from './types';
import { UplinkClient } from './uplink-client';
import { decodeUplinkCtl } from './uplink-protocol';
import { encodeUplinkCtl } from './uplink-protocol';

function status(over: Partial<UplinkStatus> = {}): UplinkStatus {
  return {
    version: '1.0.0',
    tmux: true,
    direct_capable: false,
    inventory: { devices: [] },
    endpoints: ['ws://127.0.0.1:39001/peer'],
    ...over,
  };
}

describe('UplinkClient', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('authenticates, sends node.status, applies node.list and key.log catch-up', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const applied: { bytes: Uint8Array; sig: Uint8Array }[] = [];
    const applier: KeyLogApplier = {
      async head() {
        return { seq: 1n, hash: new Uint8Array(32) };
      },
      async applyMany(_userId, records) {
        applied.push(...records);
        return { applied: records.length };
      },
    };
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => {
      received.push(new TextDecoder().decode(bytes));
    });

    const nodeId = 'ab'.repeat(16);
    const identity = { nodeId, edSecretKey: randomBytes(32) };
    const lists: unknown[] = [];
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity,
      userId: 'user-1',
      keyLogApplier: applier,
      userStore,
      statusProvider: () => status(),
      onNodeList: (list) => lists.push(list),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);

    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    await waitUntil(() => received.some((row) => row.includes('auth.response')));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    expect(received.some((row) => row.includes('node.status'))).toBe(true);

    const peerId = 'cd'.repeat(16);
    admitPeer(userStore, peerId);
    const recBytes = randomBytes(8);
    const recSig = randomBytes(64);
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 4,
        key_log_head: { seq: 3n, hash: randomBytes(32) },
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: nodeId,
            name: 'self',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
          {
            id: peerId,
            name: 'peer',
            online: true,
            endpoints: ['ws://10.0.0.2:39001/peer'],
            inventory: { devices: [1] },
            direct_capable: true,
            version: '1.0.0',
          },
        ],
      })
    );
    await waitUntil(() => userStore.listPeers().some((row) => row.nodeId === peerId));
    expect(userStore.listPeers().find((row) => row.nodeId === nodeId)).toBeUndefined();
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: recBytes, sig: recSig }],
      })
    );
    await waitUntil(() => applied.length > 0);
    expect(applied[0]?.bytes).toEqual(recBytes);
    expect(lists).toHaveLength(1);

    const relayIncoming = new Promise((resolve) => hub.onStream(resolve));
    const relay = await client.openRelay(peerId);
    const opened = await relayIncoming;
    expect((opened as { openPayload: Uint8Array }).openPayload).toEqual(
      new TextEncoder().encode(JSON.stringify({ to: peerId }))
    );
    relay.end();
  });

  test('backs off after a failed socket then reconnects', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = new ImmediateScheduler();
    let calls = 0;
    const [okClient, okHub] = fakeSocketPair();
    const hub = new WebSocketLink(okHub, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'http://127.0.0.1:1',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
      },
      userStore,
      statusProvider: () => status(),
      scheduler,
      wsFactory: () => {
        calls += 1;
        if (calls === 1) {
          const [fail] = fakeSocketPair();
          setTimeout(() => fail.close(1000, 'boom'), 20);
          return fail;
        }
        return okClient;
      },
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => calls >= 2);
    expect(scheduler.sleeps).toBeGreaterThanOrEqual(1);
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    await waitUntil(() => true);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
  });

  test('three missed pongs reconnect the uplink', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = new ImmediateScheduler();
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
      },
      userStore,
      statusProvider: () => status(),
      scheduler,
      pingIntervalMs: 15_000,
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    for (let i = 0; i < 4; i++) scheduler.tickIntervals();
    await waitUntil(() => client.state !== 'online');
  });

  test('signs uplinkAuthMessage once while authenticating and ignores a second challenge', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const keys = generateEd25519KeyPair();
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: Uint8Array[] = [];
    hub.ctl.onMessage((bytes) => received.push(bytes.slice()));
    const hubUrl = 'https://hub.example.com';
    const client = new UplinkClient({
      hubUrl,
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: keys.secretKey },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);

    const nonce = randomBytes(32);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(nonce) }));
    await waitUntil(() => received.length > 0);
    const response = received
      .map((row) => decodeUplinkCtl(row))
      .find((msg) => msg.t === 'auth.response');
    expect(response?.t).toBe('auth.response');
    if (response?.t !== 'auth.response') throw new Error('expected auth.response');
    const sig = decodeBase64url(response.sig);
    expect(
      verifyEd25519(sig, uplinkAuthMessage(nonce, hubHostFromUrl(hubUrl)), keys.publicKey)
    ).toBe(true);
    expect(verifyEd25519(sig, nonce, keys.publicKey)).toBe(false);

    const before = received.length;
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.length).toBe(before);
  });

  test('does not sign a challenge whose nonce is not 32 bytes', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(16)) }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(received.some((row) => row.includes('auth.response'))).toBe(false);
  });

  test('connect timeout and auth timeout close the socket and back off', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = new ImmediateScheduler();
    let calls = 0;
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      scheduler,
      connectTimeoutMs: 20,
      authTimeoutMs: 20,
      wsFactory: () => {
        calls += 1;
        return {
          readyState: 0,
          addEventListener() {},
          close() {},
        } as unknown as WebSocket;
      },
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => calls >= 2);
    expect(scheduler.sleeps).toBeGreaterThanOrEqual(1);
  });

  test('unexpected close after auth backs off instead of hot-looping', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = new ImmediateScheduler();
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    let calls = 0;
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      scheduler,
      wsFactory: () => {
        calls += 1;
        if (calls === 1) return clientWs;
        return fakeSocketPair()[0];
      },
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    const sleepsBefore = scheduler.sleeps;
    clientWs.close(1000, 'hub-gone');
    await waitUntil(() => scheduler.sleeps > sleepsBefore);
    expect(client.state).not.toBe('online');
  });

  test('same seq different hash surfaces key_log_fork and does not send key.log.req', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const forks: unknown[] = [];
    const localHash = new Uint8Array(32).fill(1);
    const remoteHash = new Uint8Array(32).fill(2);
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq: 3n, hash: localHash };
        },
        async applyMany() {
          return { applied: 0 };
        },
      },
      userStore,
      statusProvider: () => status(),
      onKeyLogFork: (event) => forks.push(event),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: remoteHash },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => forks.length === 1);
    expect(received.some((row) => row.includes('key.log.req'))).toBe(false);
  });

  test('does not send a second key.log.req while catch-up is in flight', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    const head = { seq: 5n, hash: randomBytes(32) };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: head,
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 2,
        key_log_head: head,
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.filter((row) => row.includes('key.log.req')).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.filter((row) => row.includes('key.log.req'))).toHaveLength(1);
  });

  test('persists hub meta from node.list and pushes missing records when local is ahead', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const rec4 = { seq: 4n, bytes: randomBytes(8), sig: randomBytes(64) };
    const rec5 = { seq: 5n, bytes: randomBytes(8), sig: randomBytes(64) };
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq: 5n, hash: randomBytes(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
        async list() {
          return [rec4, rec5];
        },
      },
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 9,
        key_log_head: { seq: 3n, hash: randomBytes(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'ff'.repeat(16), publicUrl: 'https://hub.example.com' },
      })
    );
    await waitUntil(() => userStore.getHubMeta()?.nodeId === 'ff'.repeat(16));
    expect(userStore.getHubMeta()?.publicUrl).toBe('https://hub.example.com');
    await waitUntil(() => received.some((row) => row.includes('key.log.append')));
    const first = JSON.parse(received.find((row) => row.includes('key.log.append')) ?? '{}') as {
      t?: string;
      id?: string;
    };
    expect(first.id).toBeTruthy();
    hub.ctl.send(encodeUplinkCtl({ t: 'key.log.ack', id: first.id ?? '', ok: true, seq: 4n }));
    await waitUntil(() => received.filter((row) => row.includes('key.log.append')).length >= 2);
    const second = received
      .map((row) => JSON.parse(row) as { t?: string; id?: string })
      .filter((row) => row.t === 'key.log.append')[1];
    hub.ctl.send(encodeUplinkCtl({ t: 'key.log.ack', id: second?.id ?? '', ok: true, seq: 5n }));
  });

  test('appendAndAck waits for key.log.ack', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    const bytes = randomBytes(8);
    const sig = randomBytes(64);
    const pending = client.appendAndAck({ bytes, sig });
    await waitUntil(() => received.some((row) => row.includes('key.log.append')));
    const sent = JSON.parse(received.find((row) => row.includes('key.log.append')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(encodeUplinkCtl({ t: 'key.log.ack', id: sent.id ?? '', ok: true, seq: 12n }));
    const ack = await pending;
    expect(ack.ok).toBe(true);
    expect(ack.seq).toBe(12n);
  });

  test('node.list does not upsert unknown, cross-user, or revoked nodes into peer_cache', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    seedUser(userStore, 'user-2');
    const unknownId = '11'.repeat(16);
    const otherUserId = '22'.repeat(16);
    const revokedId = '33'.repeat(16);
    const admittedId = '44'.repeat(16);
    admitPeer(userStore, otherUserId, 'user-2');
    admitPeer(userStore, revokedId, 'user-1', 7);
    admitPeer(userStore, admittedId);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const lists: unknown[] = [];
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      onNodeList: (list) => lists.push(list),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 3,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: unknownId,
            name: 'unknown',
            online: true,
            endpoints: ['ws://10.0.0.9:39001/peer'],
            inventory: {},
            direct_capable: true,
            version: '1.0.0',
          },
          {
            id: otherUserId,
            name: 'other-user',
            online: true,
            endpoints: ['ws://10.0.0.8:39001/peer'],
            inventory: {},
            direct_capable: true,
            version: '1.0.0',
          },
          {
            id: revokedId,
            name: 'revoked',
            online: true,
            endpoints: ['ws://10.0.0.7:39001/peer'],
            inventory: {},
            direct_capable: true,
            version: '1.0.0',
          },
          {
            id: admittedId,
            name: 'admitted',
            online: true,
            endpoints: ['ws://10.0.0.6:39001/peer'],
            inventory: { devices: [1] },
            direct_capable: true,
            version: '1.0.0',
          },
        ],
      })
    );
    await waitUntil(() => lists.length === 1);
    const cached = userStore
      .listPeers()
      .map((row) => row.nodeId)
      .sort();
    expect(cached).toEqual([admittedId]);
    expect(userStore.listPeers().find((row) => row.nodeId === admittedId)?.name).toBe('admitted');
  });
});

function admitPeer(
  store: UserStore,
  nodeId: string,
  userId = 'user-1',
  revokedLogSeq?: number
): void {
  store.upsertCert({
    nodeId,
    userId,
    admitRecordSeq: 1,
    certificateBytes: randomBytes(8),
    certSig: randomBytes(64),
    authorizationBytes: randomBytes(8),
    authorizationSig: randomBytes(64),
    revokedLogSeq: revokedLogSeq ?? null,
  });
}

function dummyApplier() {
  return {
    async head() {
      return { seq: 0n, hash: new Uint8Array(32) };
    },
    async applyMany() {
      return { applied: 0 };
    },
  };
}
