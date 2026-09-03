import { afterEach, describe, expect, test } from 'bun:test';
import {
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hubHostFromUrl,
  nodeIdToHex,
  randomBytes,
  uplinkAuthMessage,
  verifyEd25519,
} from '@tmex/shared/auth';
import { WebSocketLink } from '@tmex/shared/link';
import {
  type RelayCtlMessage,
  decodeRelayCtl,
  decodeRelayRtcBlob,
  decodeRelayStatusBlob,
  encodeRelayCtl,
  encodeRelayRtcBlob,
  encodeRelayStatusBlob,
  generateTenantKey,
  openEnvelope,
  sealEnvelope,
} from '@tmex/shared/relay';
import { KeyLogStore } from '../auth/key-log-store';
import { type NodeIdentityKeys, ensureNodeIdentity } from '../auth/node-identity-service';
import { selfSignedNodeCertificate } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';
import { RelaySecrets } from './relay-secrets';
import { RelayUplinkClient } from './relay-uplink-client';
import { relayUplinkWsUrl } from './relay-uplink-http';
import { fakeSocketPair, waitUntil } from './test-support';
import type { KeyLogApplier, UplinkStatus } from './types';

const RELAY_URL = 'https://relay.example';
const TENANT_ID = 'cd'.repeat(16);
const TOKEN = new Uint8Array(32).fill(5);

function status(): UplinkStatus {
  return {
    version: '1.1.23',
    tmux: true,
    direct_capable: true,
    inventory: { devices: [1] },
    endpoints: ['ws://10.0.0.1:39001/peer'],
  };
}

function fakeIdentity(): NodeIdentityKeys {
  const ed = generateEd25519KeyPair();
  const x = generateX25519KeyPair();
  const nodeId = randomBytes(16);
  return {
    nodeId,
    nodeIdHex: nodeIdToHex(nodeId),
    hubUrl: null,
    edPrivateKey: ed.secretKey,
    edPublicKey: ed.publicKey,
    x25519PrivateKey: x.secretKey,
    x25519PublicKey: x.publicKey,
  };
}

async function bootRelayNode() {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const service = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await service.bootstrapUserWithSelfAdmit({
    username: 'relay-node',
    password: 'relay-node-pass',
    identity,
  });
  const peer = fakeIdentity();
  const admit = await selfSignedNodeCertificate(peer, user.rootKey, {
    uid: user.userId,
    rootEpoch: 1,
    now: Date.now(),
  });
  const admitted = await service.signAndApply(user.userId, user.rootKey, {
    type: 'admit-node',
    payload: encodeAdmitNodePayload(admit),
  });
  if (!admitted.ok) throw new Error('admit-node failed');
  const secrets = new RelaySecrets({
    db,
    identity: { nodeIdHex: identity.nodeIdHex, x25519PrivateKey: identity.x25519PrivateKey },
    userIdOf: () => user.userId,
  });
  const metaKey = generateTenantKey();
  const logKey = generateTenantKey();
  const applied = await service.signAndApply(user.userId, user.rootKey, {
    type: 'set-relays',
    payload: await buildSetRelaysPayload({
      relays: [{ url: RELAY_URL, tenantId: TENANT_ID, token: TOKEN, priority: 0 }],
      logKey,
      metaKey,
      metaEpoch: 1,
      nodes: listRelayNodeKeys(userStore, user.userId),
    }),
  });
  if (!applied.ok) throw new Error('set-relays failed');
  await secrets.reconcile();
  return { db, close, userStore, service, identity, peer, user, secrets, metaKey, logKey };
}

type Harness = {
  received: RelayCtlMessage[];
  send: (msg: RelayCtlMessage) => void;
  streams: unknown[];
};

function fakeRelayServer(link: WebSocketLink, headSeq: number): Harness {
  const received: RelayCtlMessage[] = [];
  const streams: unknown[] = [];
  const send = (msg: RelayCtlMessage) => link.ctl.send(encodeRelayCtl(msg));
  link.ctl.onMessage((bytes) => {
    const msg = decodeRelayCtl(bytes);
    received.push(msg);
    if (msg.t === 'relay.auth') {
      send({
        t: 'auth.ok',
        tenant_id: msg.tenant_id,
        key_log_head_seq: headSeq,
        rtc: { stun: ['stun:stun.example:3478'], turn: null },
      });
    }
  });
  link.onStream((stream) => streams.push(stream));
  return { received, send, streams };
}

describe('RelayUplinkClient', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('relay.auth 带租户令牌、主机绑定签名与成员证明，auth.ok 后上报状态块', async () => {
    const b = await bootRelayNode();
    fixtures.push({ close: b.close });
    const [clientWs, serverWs] = fakeSocketPair();
    const server = fakeRelayServer(new WebSocketLink(serverWs, { role: 'acceptor' }), 2);
    const nonce = randomBytes(32);
    const client = new RelayUplinkClient({
      hubUrl: RELAY_URL,
      identity: { nodeId: b.identity.nodeIdHex, edSecretKey: b.identity.edPrivateKey },
      userId: () => b.user.userId,
      keyLogApplier: realApplier(b.service),
      userStore: b.userStore,
      secrets: b.secrets,
      statusProvider: status,
      nameProvider: () => 'node-a',
      wsFactory: () => clientWs,
    });
    fixtures.push({ close: () => {}, stop: () => client.stop() });
    const connecting = client.attemptConnect();
    await waitUntil(() => client.link !== null);
    server.send({ t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    await connecting;
    expect(client.state).toBe('online');

    const auth = server.received.find((msg) => msg.t === 'relay.auth');
    if (auth?.t !== 'relay.auth') throw new Error('missing relay.auth');
    expect(auth.tenant_id).toBe(TENANT_ID);
    expect(decodeBase64url(auth.token)).toEqual(TOKEN);
    expect(auth.node_id).toBe(b.identity.nodeIdHex);
    expect(auth.proto).toBe(1);
    expect(auth.member).toBeDefined();
    expect(
      verifyEd25519(
        decodeBase64url(auth.sig),
        uplinkAuthMessage(nonce, hubHostFromUrl(RELAY_URL)),
        b.identity.edPublicKey
      )
    ).toBe(true);

    await waitUntil(() => server.received.some((msg) => msg.t === 'relay.status'));
    const statusMsg = server.received.find((msg) => msg.t === 'relay.status');
    if (statusMsg?.t !== 'relay.status') throw new Error('missing relay.status');
    expect(statusMsg.epoch).toBe(1);
    const blob = decodeRelayStatusBlob(await openEnvelope(b.metaKey, 'status', statusMsg.blob));
    expect(blob.name).toBe('node-a');
    expect(blob.version).toBe('1.1.23');
    expect(blob.endpoints).toEqual(['ws://10.0.0.1:39001/peer']);
  });

  test('relay.list 解密对端状态块写 peer_cache，并产出 node.list 形状', async () => {
    const b = await bootRelayNode();
    fixtures.push({ close: b.close });
    const [clientWs, serverWs] = fakeSocketPair();
    const server = fakeRelayServer(new WebSocketLink(serverWs, { role: 'acceptor' }), 2);
    const lists: Array<{ nodes: Array<{ id: string; name: string }> }> = [];
    const client = new RelayUplinkClient({
      hubUrl: RELAY_URL,
      identity: { nodeId: b.identity.nodeIdHex, edSecretKey: b.identity.edPrivateKey },
      userId: () => b.user.userId,
      keyLogApplier: noopApplier(2n),
      userStore: b.userStore,
      secrets: b.secrets,
      statusProvider: status,
      onNodeList: (list) => lists.push(list),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close: () => {}, stop: () => client.stop() });
    const connecting = client.attemptConnect();
    await waitUntil(() => client.link !== null);
    server.send({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) });
    await connecting;

    const peerBlob = await sealEnvelope(
      b.metaKey,
      'status',
      encodeRelayStatusBlob({
        name: 'node-b',
        version: '1.1.23',
        tmux: true,
        inventory: { devices: [2] },
        endpoints: ['ws://10.0.0.2:39001/peer'],
      }),
      1
    );
    server.send({
      t: 'relay.list',
      version: 7,
      key_log_head_seq: 2,
      rtc: { stun: [], turn: null },
      nodes: [
        {
          id: b.peer.nodeIdHex,
          online: true,
          status: 'admitted',
          direct_capable: true,
          epoch: 1,
          blob: peerBlob,
        },
        {
          id: b.identity.nodeIdHex,
          online: true,
          status: 'admitted',
          direct_capable: true,
        },
      ],
    });
    await waitUntil(() => lists.length > 0);
    expect(lists[0]?.nodes.map((node) => node.id)).toEqual([b.peer.nodeIdHex]);
    expect(lists[0]?.nodes[0]?.name).toBe('node-b');
    const cached = b.userStore.getPeer(b.peer.nodeIdHex);
    expect(cached?.name).toBe('node-b');
    expect(cached?.endpointsJson).toBe(JSON.stringify(['ws://10.0.0.2:39001/peer']));
    expect(client.nodesViaRelay).toBe(1);
  });

  test('relay.rtc 双向加解密，openRelay 首帧与 hub 一致', async () => {
    const b = await bootRelayNode();
    fixtures.push({ close: b.close });
    const [clientWs, serverWs] = fakeSocketPair();
    const server = fakeRelayServer(new WebSocketLink(serverWs, { role: 'acceptor' }), 2);
    const signals: Array<{ sdp?: string; to: string }> = [];
    const client = new RelayUplinkClient({
      hubUrl: RELAY_URL,
      identity: { nodeId: b.identity.nodeIdHex, edSecretKey: b.identity.edPrivateKey },
      userId: () => b.user.userId,
      keyLogApplier: noopApplier(2n),
      userStore: b.userStore,
      secrets: b.secrets,
      statusProvider: status,
      onRtcSignal: (msg) => signals.push(msg),
      wsFactory: () => clientWs,
    });
    fixtures.push({ close: () => {}, stop: () => client.stop() });
    const connecting = client.attemptConnect();
    await waitUntil(() => client.link !== null);
    server.send({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) });
    await connecting;

    server.send({
      t: 'relay.rtc',
      rtcSession: 'sess-1',
      from: 'browser',
      to: b.identity.nodeIdHex,
      enc: await sealEnvelope(b.metaKey, 'rtc', encodeRelayRtcBlob({ sdp: 'v=0' }), 1),
    });
    await waitUntil(() => signals.length > 0);
    expect(signals[0]?.sdp).toBe('v=0');

    client.sendCtl({
      t: 'rtc.signal',
      rtcSession: 'sess-2',
      from: 'node',
      to: b.peer.nodeIdHex,
      candidate: 'candidate:1',
    });
    await waitUntil(() => server.received.some((msg) => msg.t === 'relay.rtc'));
    const out = server.received.find((msg) => msg.t === 'relay.rtc');
    if (out?.t !== 'relay.rtc') throw new Error('missing relay.rtc');
    expect(out.to).toBe(b.peer.nodeIdHex);
    expect(decodeRelayRtcBlob(await openEnvelope(b.metaKey, 'rtc', out.enc)).candidate).toBe(
      'candidate:1'
    );

    const stream = await client.openRelay(b.peer.nodeIdHex);
    await waitUntil(() => server.streams.length > 0);
    expect((server.streams[0] as { openPayload: Uint8Array }).openPayload).toEqual(
      new TextEncoder().encode(JSON.stringify({ to: b.peer.nodeIdHex }))
    );
    stream.end();
  });

  test('relay.kicked 标记中继行并断开', async () => {
    const b = await bootRelayNode();
    fixtures.push({ close: b.close });
    const [clientWs, serverWs] = fakeSocketPair();
    const server = fakeRelayServer(new WebSocketLink(serverWs, { role: 'acceptor' }), 2);
    const kicks: string[] = [];
    const client = new RelayUplinkClient({
      hubUrl: RELAY_URL,
      identity: { nodeId: b.identity.nodeIdHex, edSecretKey: b.identity.edPrivateKey },
      userId: () => b.user.userId,
      keyLogApplier: noopApplier(2n),
      userStore: b.userStore,
      secrets: b.secrets,
      statusProvider: status,
      onKicked: (reason) => {
        kicks.push(reason);
        b.secrets.store.markKicked(b.secrets.relayRows()[0]?.url ?? '', true);
      },
      wsFactory: () => clientWs,
    });
    fixtures.push({ close: () => {}, stop: () => client.stop() });
    const connecting = client.attemptConnect();
    await waitUntil(() => client.link !== null);
    server.send({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) });
    await connecting;

    server.send({ t: 'relay.kicked', reason: 'password_rotated' });
    await waitUntil(() => kicks.length > 0);
    expect(kicks[0]).toBe('password_rotated');
    expect(b.secrets.relayRows()[0]?.kicked).toBe(true);
    expect(client.state).not.toBe('online');
  });
});

describe('relayUplinkWsUrl', () => {
  test('把 https/http 换成 wss/ws 并落到 /relay/uplink', () => {
    expect(relayUplinkWsUrl('https://relay.example')).toBe('wss://relay.example/relay/uplink');
    expect(relayUplinkWsUrl('http://127.0.0.1:9000/x?q=1')).toBe(
      'ws://127.0.0.1:9000/relay/uplink'
    );
  });
});

function realApplier(service: UserKeyService): KeyLogApplier {
  return {
    head: (userId, signal) => service.head(userId, signal),
    list: (userId, fromSeq, signal, limit) => service.list(userId, fromSeq, signal, limit),
    async applyMany(userId, records, signal) {
      const result = await service.applyMany(userId, records, signal);
      return result.ok
        ? { applied: result.applied }
        : { applied: result.applied, error: result.error };
    },
  };
}

function noopApplier(seq: bigint): KeyLogApplier {
  return {
    async head() {
      return { seq, hash: new Uint8Array(32) };
    },
    async applyMany() {
      return { applied: 0 };
    },
    async list() {
      return [];
    },
  };
}
