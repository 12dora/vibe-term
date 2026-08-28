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
import type { KeyLogApplier, KeyLogForkEvent, UplinkStatus } from './types';
import { UplinkClient } from './uplink-client';
import { type UplinkNodeList, decodeUplinkCtl, encodeUplinkCtl } from './uplink-protocol';

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
    const hash1 = new Uint8Array(32);
    hash1[0] = 1;
    const hash3 = new Uint8Array(32);
    hash3[0] = 3;
    let seq = 1n;
    const applier: KeyLogApplier = {
      async head() {
        return { seq, hash: seq === 1n ? hash1 : hash3 };
      },
      async applyMany(_userId, records) {
        applied.push(...records);
        seq = 3n;
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
        key_log_head: { seq: 3n, hash: hash3 },
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
    const firstReq = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: recBytes, sig: recSig }],
        ...(firstReq.id ? { id: firstReq.id } : {}),
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

  test('node.list catch-up persists a newly admitted peer after key.log apply', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lateId = '55'.repeat(16);
    const hash1 = new Uint8Array(32);
    hash1[0] = 1;
    const hash2 = new Uint8Array(32);
    hash2[0] = 2;
    let seq = 1n;
    const recBytes = randomBytes(8);
    const recSig = randomBytes(64);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const lists: unknown[] = [];
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq, hash: seq === 1n ? hash1 : hash2 };
        },
        async applyMany(_userId, records) {
          admitPeer(userStore, lateId);
          seq = 2n;
          return { applied: records.length };
        },
      },
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
        version: 6,
        key_log_head: { seq: 2n, hash: hash2 },
        rtc: { stun: [], turn: null },
        hub: { nodeId: 'ff'.repeat(16), publicUrl: 'https://hub.example.com' },
        nodes: [
          {
            id: lateId,
            name: 'late',
            online: true,
            endpoints: ['ws://10.0.0.5:39001/peer'],
            inventory: { devices: [2] },
            direct_capable: false,
            version: '1.0.2',
          },
        ],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    expect(userStore.getCert(lateId)).toBeNull();
    const lateReq = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: recBytes, sig: recSig }],
        ...(lateReq.id ? { id: lateReq.id } : {}),
      })
    );
    await waitUntil(() => userStore.getCert(lateId) !== null);
    await waitUntil(() => userStore.listPeers().some((row) => row.nodeId === lateId));
    expect(userStore.getHubMeta()?.nodeId).toBe('ff'.repeat(16));
    expect(userStore.listPeers().find((row) => row.nodeId === lateId)?.name).toBe('late');
    expect(lists).toHaveLength(1);
  });

  test('key.log.req timeout does not finish node.list as synced', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
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
      keyLogTimeoutMs: 40,
      keyLogRetryLimit: 0,
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
        version: 4,
        key_log_head: { seq: 3n, hash: randomBytes(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lists).toHaveLength(0);
  });

  test('newer node.list wins if an older catch-up later finishes', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const peerId = 'cd'.repeat(16);
    admitPeer(userStore, peerId);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const lists: UplinkNodeList[] = [];
    const hash1 = new Uint8Array(32);
    hash1[0] = 1;
    const hash2 = new Uint8Array(32);
    hash2[0] = 2;
    let seq = 1n;
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          return { seq, hash: seq === 1n ? hash1 : hash2 };
        },
        async applyMany(_userId, records) {
          seq += BigInt(records.length);
          return { applied: records.length };
        },
      },
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
    const head = { seq: 2n, hash: hash2 };
    const recBytes = randomBytes(8);
    const recSig = randomBytes(64);
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: head,
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: peerId,
            name: 'old-name',
            online: true,
            endpoints: ['ws://10.0.0.1:39001/peer'],
            inventory: {},
            direct_capable: false,
            version: '1',
          },
        ],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 2,
        key_log_head: head,
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: peerId,
            name: 'new-name',
            online: true,
            endpoints: ['ws://10.0.0.2:39001/peer'],
            inventory: {},
            direct_capable: true,
            version: '2',
          },
        ],
      })
    );
    const req = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: recBytes, sig: recSig }],
        ...(req.id ? { id: req.id } : {}),
      })
    );
    await waitUntil(() => lists.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(userStore.listPeers().find((row) => row.nodeId === peerId)?.name).toBe('new-name');
    expect(lists.at(-1)?.version).toBe(2);
  });

  test('ignores node.list and key-log frames until auth.ok', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
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
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 9,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'ff'.repeat(16), publicUrl: 'https://evil.example' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(userStore.getHubMeta()).toBeNull();
    expect(lists).toHaveLength(0);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 10,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://hub.example.com' },
      })
    );
    await waitUntil(() => userStore.getHubMeta()?.nodeId === 'aa'.repeat(16));
    expect(userStore.getHubMeta()?.publicUrl).toBe('https://hub.example.com');
  });

  test('ctl decode errors are warned with type and length, not the payload', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({
      close,
      stop: async () => {
        console.warn = orig;
        await client.stop();
      },
    });
    client.start();
    await waitUntil(() => client.link !== null);
    const payload = '{"t":"node.list","secret":"should-not-log"}';
    hub.ctl.send(new TextEncoder().encode(payload));
    await waitUntil(() => warnings.some((row) => row.includes('decode')));
    expect(warnings.some((row) => row.includes('node.list'))).toBe(true);
    expect(warnings.some((row) => row.includes(String(payload.length)))).toBe(true);
    expect(warnings.join('\n')).not.toContain('should-not-log');
  });

  test('push NACK does not finish node.list and tears down after retries', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lists: unknown[] = [];
    const rec = { seq: 4n, bytes: randomBytes(8), sig: randomBytes(64) };
    const { client, hub, received } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 4n, hash: randomBytes(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
        async list() {
          return [rec];
        },
      },
      onNodeList: (list) => lists.push(list),
      keyLogRetryLimit: 0,
    });
    hub.ctl.onMessage((bytes) => {
      const text = new TextDecoder().decode(bytes);
      received.push(text);
      const msg = JSON.parse(text) as { t?: string; id?: string };
      if (msg.t === 'key.log.append' && msg.id) {
        hub.ctl.send(encodeUplinkCtl({ t: 'key.log.ack', id: msg.id, ok: false, error: 'nack' }));
      }
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: randomBytes(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => client.state !== 'online' || client.link === null);
    expect(lists).toHaveLength(0);
    expect(client.state).not.toBe('online');
  });

  test('applyMany invalid_signature does not finish node.list and tears down', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lists: unknown[] = [];
    const { client, hub, received } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 1n, hash: new Uint8Array(32).fill(1) };
        },
        async applyMany() {
          return { applied: 0, error: 'invalid_signature' };
        },
      },
      onNodeList: (list) => lists.push(list),
      keyLogRetryLimit: 0,
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    const req = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
        ...(req.id ? { id: req.id } : {}),
      })
    );
    await waitUntil(() => client.state !== 'online' || client.link === null);
    expect(lists).toHaveLength(0);
    expect(client.state).not.toBe('online');
  });

  test('applyMany fork calls failFork and does not finish node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lists: unknown[] = [];
    const forks: KeyLogForkEvent[] = [];
    const { client, hub, received } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 1n, hash: new Uint8Array(32).fill(1) };
        },
        async applyMany() {
          return { applied: 0, error: 'fork' };
        },
      },
      onNodeList: (list) => lists.push(list),
      onKeyLogFork: (event) => forks.push(event),
      keyLogRetryLimit: 3,
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    const req = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
        ...(req.id ? { id: req.id } : {}),
      })
    );
    await waitUntil(() => forks.length === 1);
    expect(lists).toHaveLength(0);
    expect(client.state).not.toBe('online');
  });

  test('stalled key-log head does not finish node.list and tears down', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lists: unknown[] = [];
    const { client, hub, received } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 1n, hash: new Uint8Array(32).fill(1) };
        },
        async applyMany() {
          return { applied: 1 };
        },
      },
      onNodeList: (list) => lists.push(list),
      keyLogRetryLimit: 0,
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    const req = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
        ...(req.id ? { id: req.id } : {}),
      })
    );
    await waitUntil(() => client.state !== 'online' || client.link === null);
    expect(lists).toHaveLength(0);
    expect(client.state).not.toBe('online');
  });

  test('partial apply re-reads head so the next request resumes from the committed prefix', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    let seq = 1n;
    let applyCalls = 0;
    const { hub, received } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq, hash: new Uint8Array(32).fill(Number(seq)) };
        },
        async applyMany() {
          applyCalls += 1;
          if (applyCalls === 1) {
            seq = 2n;
            return { applied: 1, error: 'invalid_signature' };
          }
          seq = 4n;
          return { applied: 2 };
        },
      },
      keyLogRetryLimit: 1,
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 4n, hash: new Uint8Array(32).fill(4) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    const firstReq = JSON.parse(received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
      from_seq?: string | number;
    };
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [
          { seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) },
          { seq: 3n, bytes: randomBytes(8), sig: randomBytes(64) },
          { seq: 4n, bytes: randomBytes(8), sig: randomBytes(64) },
        ],
        ...(firstReq.id ? { id: firstReq.id } : {}),
      })
    );
    await waitUntil(() => received.filter((row) => row.includes('key.log.req')).length >= 2);
    const second = received
      .map((row) => JSON.parse(row) as { t?: string; from_seq?: string | number })
      .filter((row) => row.t === 'key.log.req')[1];
    expect(String(second?.from_seq)).toBe('3');
  });

  test('connectWithLink replacement does not inherit authenticated before the new auth.ok', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
    });
    fixtures.push({ close, stop: () => client.stop() });
    const firstLink = new WebSocketLink(clientWs, { role: 'initiator' });
    const first = client.connectWithLink(firstLink);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await first;
    expect(client.state).toBe('online');

    const [nextClientWs, nextHubWs] = fakeSocketPair();
    const nextHub = new WebSocketLink(nextHubWs, { role: 'acceptor' });
    nextHub.ctl.onMessage(() => {});
    const nextLink = new WebSocketLink(nextClientWs, { role: 'initiator' });
    const second = client.connectWithLink(nextLink);
    await waitUntil(() => client.link === nextLink);
    nextHub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'ff'.repeat(16), publicUrl: 'https://preauth.invalid' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(userStore.getHubMeta()?.publicUrl).not.toBe('https://preauth.invalid');
    nextHub.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    nextHub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await second;
  });

  test('head list and applyMany throws enter the retry machine and tear down, fork stays hard', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const listsHead: unknown[] = [];
    const head = await bootOnline({
      userStore,
      applier: {
        async head() {
          throw new Error('head-io');
        },
        async applyMany() {
          return { applied: 0 };
        },
      },
      onNodeList: (list) => listsHead.push(list),
      keyLogRetryLimit: 0,
    });
    head.hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => head.client.state !== 'online' || head.client.link === null);
    expect(listsHead).toHaveLength(0);
    expect(head.client.state).not.toBe('online');
    await head.client.stop();

    const listsList: unknown[] = [];
    const listed = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 4n, hash: randomBytes(32) };
        },
        async applyMany() {
          return { applied: 0 };
        },
        async list() {
          throw new Error('list-io');
        },
      },
      onNodeList: (list) => listsList.push(list),
      keyLogRetryLimit: 0,
    });
    listed.hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: randomBytes(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => listed.client.state !== 'online' || listed.client.link === null);
    expect(listsList).toHaveLength(0);
    expect(listed.client.state).not.toBe('online');
    await listed.client.stop();

    const listsApply: unknown[] = [];
    const thrown = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: 1n, hash: new Uint8Array(32).fill(1) };
        },
        async applyMany() {
          throw new Error('apply-io');
        },
      },
      onNodeList: (list) => listsApply.push(list),
      keyLogRetryLimit: 0,
    });
    thrown.hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => thrown.received.some((row) => row.includes('key.log.req')));
    const req = JSON.parse(thrown.received.find((row) => row.includes('key.log.req')) ?? '{}') as {
      id?: string;
    };
    thrown.hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
        ...(req.id ? { id: req.id } : {}),
      })
    );
    await waitUntil(() => thrown.client.state !== 'online' || thrown.client.link === null);
    expect(listsApply).toHaveLength(0);
    expect(thrown.client.state).not.toBe('online');
  });

  test('stale catch-up from a previous generation cannot failFork the replacement connection', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const forks: KeyLogForkEvent[] = [];
    const lists: UplinkNodeList[] = [];
    const hungHead = { release() {} };
    let headCalls = 0;
    const hash0 = new Uint8Array(32);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: {
        async head() {
          headCalls += 1;
          if (headCalls === 1) {
            await new Promise<void>((resolve) => {
              hungHead.release = resolve;
            });
          }
          return { seq: 0n, hash: hash0 };
        },
        async applyMany() {
          return { applied: 0, error: 'fork' };
        },
      },
      userStore,
      statusProvider: () => status(),
      onNodeList: (list) => lists.push(list),
      onKeyLogFork: (event) => forks.push(event),
    });
    fixtures.push({ close, stop: () => client.stop() });
    const firstLink = new WebSocketLink(clientWs, { role: 'initiator' });
    const first = client.connectWithLink(firstLink);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await first;
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => headCalls === 1);

    const [nextClientWs, nextHubWs] = fakeSocketPair();
    const nextHub = new WebSocketLink(nextHubWs, { role: 'acceptor' });
    nextHub.ctl.onMessage(() => {});
    const nextLink = new WebSocketLink(nextClientWs, { role: 'initiator' });
    const second = client.connectWithLink(nextLink);
    nextHub.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    nextHub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await second;
    nextHub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: hash0 },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'bb'.repeat(16), publicUrl: 'https://gen2.example' },
      })
    );
    await waitUntil(() => lists.length === 1);
    expect(client.state).toBe('online');
    hungHead.release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(forks).toHaveLength(0);
    expect(client.state).toBe('online');
    expect(lists).toHaveLength(1);
  });

  test('replacing an online connection leaves online immediately and gates outbound and inbound OPEN', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
    });
    fixtures.push({ close, stop: () => client.stop() });
    const firstLink = new WebSocketLink(clientWs, { role: 'initiator' });
    const first = client.connectWithLink(firstLink);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await first;
    expect(client.state).toBe('online');

    const [nextClientWs, nextHubWs] = fakeSocketPair();
    const nextHub = new WebSocketLink(nextHubWs, { role: 'acceptor' });
    nextHub.ctl.onMessage(() => {});
    const nextLink = new WebSocketLink(nextClientWs, { role: 'initiator' });
    const second = client.connectWithLink(nextLink);
    await waitUntil(() => client.link === nextLink);
    expect(client.state).not.toBe('online');
    expect(() => client.sendCtl({ t: 'ping' })).toThrow(/not online/);
    await expect(client.openRelay('cd'.repeat(16))).rejects.toThrow(/not online/);
    client.sendStatus();
    const ack = await client.appendAndAck({ bytes: randomBytes(8), sig: randomBytes(64) }, 50);
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('offline');

    const opened = await nextHub.openStream(
      new TextEncoder().encode(JSON.stringify({ to: 'ab'.repeat(16), from: 'cd'.repeat(16) }))
    );
    let inboundReason = '';
    void opened.closed.then((info) => {
      inboundReason = info.reason;
    });
    await waitUntil(() => inboundReason !== '');
    expect(inboundReason === 'unauthenticated' || inboundReason === 'rst').toBe(true);

    nextHub.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    nextHub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await second;
    expect(client.state).toBe('online');
  });

  test('key.log.res without id is dropped when the outstanding request has an id', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const applied: unknown[] = [];
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const { hub, received, client } = await bootOnline({
      userStore,
      applier: {
        async head() {
          return { seq: applied.length > 0 ? 3n : 1n, hash: new Uint8Array(32).fill(1) };
        },
        async applyMany(_userId, records) {
          applied.push(...records);
          return { applied: records.length };
        },
      },
    });
    fixtures.push({
      close: () => {
        console.warn = orig;
      },
      stop: () => client.stop(),
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) },
        rtc: { stun: [], turn: null },
        nodes: [],
      })
    );
    await waitUntil(() => received.some((row) => row.includes('key.log.req')));
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(applied).toHaveLength(0);
    expect(warnings.some((row) => row.includes('missing') || row.includes('unmatched'))).toBe(true);
    const before = warnings.filter(
      (row) => row.includes('missing') || row.includes('unmatched')
    ).length;
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'key.log.res',
        records: [{ seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) }],
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      warnings.filter((row) => row.includes('missing') || row.includes('unmatched'))
    ).toHaveLength(before);
  });

  test('rejects a lower node.list version on the same connection generation', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const lists: UplinkNodeList[] = [];
    const { hub } = await bootOnline({
      userStore,
      onNodeList: (list) => lists.push(list),
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 2,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://new.example' },
      })
    );
    await waitUntil(() => userStore.getHubMeta()?.publicUrl === 'https://new.example');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://old.example' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(userStore.getHubMeta()?.publicUrl).toBe('https://new.example');
    expect(userStore.listPeers().find((row) => row.nodeId === 'hub')?.listVersion).toBe(2);
    expect(lists.every((row) => row.version !== 1)).toBe(true);
  });

  test('resets node.list version watermark on a new connection generation', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
    });
    fixtures.push({ close, stop: () => client.stop() });
    const firstLink = new WebSocketLink(clientWs, { role: 'initiator' });
    const first = client.connectWithLink(firstLink);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await first;
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 5,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'aa'.repeat(16), publicUrl: 'https://gen1.example' },
      })
    );
    await waitUntil(() => userStore.getHubMeta()?.publicUrl === 'https://gen1.example');
    expect(userStore.listPeers().find((row) => row.nodeId === 'hub')?.listVersion).toBe(5);

    const [nextClientWs, nextHubWs] = fakeSocketPair();
    const nextHub = new WebSocketLink(nextHubWs, { role: 'acceptor' });
    nextHub.ctl.onMessage(() => {});
    const nextLink = new WebSocketLink(nextClientWs, { role: 'initiator' });
    const second = client.connectWithLink(nextLink);
    nextHub.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    nextHub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await second;
    nextHub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hub: { nodeId: 'bb'.repeat(16), publicUrl: 'https://gen2.example' },
      })
    );
    await waitUntil(() => userStore.getHubMeta()?.publicUrl === 'https://gen2.example');
    expect(userStore.listPeers().find((row) => row.nodeId === 'hub')?.listVersion).toBe(1);
  });

  test('ctl warn maps illegal type to unknown, uses fixed error codes, and strips control chars', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => status(),
      wsFactory: () => clientWs,
    });
    fixtures.push({
      close,
      stop: async () => {
        console.warn = orig;
        await client.stop();
      },
    });
    client.start();
    await waitUntil(() => client.link !== null);
    const injected = '{"t":"evil\\ninject secret=pw","x":"fragment"}';
    hub.ctl.send(new TextEncoder().encode(injected));
    await waitUntil(() => warnings.some((row) => row.includes('decode')));
    const line = warnings.find((row) => row.includes('decode')) ?? '';
    expect(line).toContain('type=unknown');
    expect(line).toMatch(/err=[a-z_]+/);
    expect(line).not.toContain('evil');
    expect(line).not.toContain('inject');
    expect(line).not.toContain('secret=pw');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('fragment');
  });

  async function bootOnline(opts: {
    userStore: UserStore;
    applier?: KeyLogApplier;
    onNodeList?: (list: UplinkNodeList) => void;
    onKeyLogFork?: (event: KeyLogForkEvent) => void;
    keyLogTimeoutMs?: number;
    keyLogRetryLimit?: number;
  }): Promise<{
    client: UplinkClient;
    hub: WebSocketLink;
    received: string[];
    nodeId: string;
  }> {
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: string[] = [];
    hub.ctl.onMessage((bytes) => received.push(new TextDecoder().decode(bytes)));
    const nodeId = 'ab'.repeat(16);
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId, edSecretKey: randomBytes(32) },
      userId: 'user-1',
      keyLogApplier: opts.applier ?? dummyApplier(),
      userStore: opts.userStore,
      statusProvider: () => status(),
      onNodeList: opts.onNodeList,
      onKeyLogFork: opts.onKeyLogFork,
      wsFactory: () => clientWs,
      keyLogTimeoutMs: opts.keyLogTimeoutMs,
      keyLogRetryLimit: opts.keyLogRetryLimit,
    });
    fixtures.push({ close: () => {}, stop: () => client.stop() });
    client.start();
    await waitUntil(() => client.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => client.state === 'online');
    return { client, hub, received, nodeId };
  }
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
