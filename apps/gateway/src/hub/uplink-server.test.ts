import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  computeRecordHash,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootPayload,
  generateEd25519KeyPair,
  generateKdfParams,
  randomBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { type LinkSession, type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import { eq } from 'drizzle-orm';
import { createMigratedAuthDb } from '../auth/test-db';
import type { UserStore } from '../auth/user-store';
import { nodes } from '../db/schema';
import {
  type CtlInbox,
  autoPong,
  createHubTestStack,
  ctlInbox,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  sendRawCtl,
  signAuth,
  signUserRecord,
} from './hub-test-helpers';
import { NodeRegistry } from './node-registry';
import type { HubKeyLogSource } from './types';
import type { UplinkCtlMessage } from './uplink-protocol';
import { UplinkServer } from './uplink-server';

function makeServer(
  db: ReturnType<typeof createMigratedAuthDb>['db'],
  store: UserStore,
  keyLog: HubKeyLogSource,
  extras?: {
    heartbeatIntervalMs?: number;
    heartbeatMissLimit?: number;
    authTimeoutMs?: number;
    rtcMaxSessions?: number;
    now?: () => number;
  }
) {
  const registry = new NodeRegistry();
  const server = new UplinkServer({
    db,
    userStore: store,
    keyLogSource: keyLog,
    registry,
    config: { publicUrl: 'https://hub.example', stun: ['stun:example:3478'], turn: null },
    heartbeatIntervalMs: extras?.heartbeatIntervalMs ?? 60_000,
    heartbeatMissLimit: extras?.heartbeatMissLimit ?? 3,
    authTimeoutMs: extras?.authTimeoutMs ?? 60_000,
    rtcMaxSessions: extras?.rtcMaxSessions,
    now: extras?.now,
  });
  return { server, registry };
}

async function authNode(
  server: UplinkServer,
  store: UserStore,
  userId: string,
  opts?: { name?: string; revoked?: boolean }
): Promise<{
  nodeId: string;
  nodeIdBytes: Uint8Array;
  ed: { secretKey: Uint8Array; publicKey: Uint8Array };
  nodeLink: LinkSession;
  hubLink: LinkSession;
  inbox: CtlInbox;
}> {
  const seeded = seedAdmittedNode(store, userId, opts);
  const [nodeLink, hubLink] = createInMemoryLinkPair();
  const inbox = ctlInbox(nodeLink);
  server.accept(hubLink);
  const challenge = await inbox.take();
  expect(challenge.t).toBe('auth.challenge');
  if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
  sendCtl(nodeLink, {
    t: 'auth.response',
    node_id: seeded.nodeId,
    sig: signAuth(seeded.ed.secretKey, decodeBase64url(challenge.nonce)),
  });
  const ok = await inbox.take();
  expect(ok.t).toBe('auth.ok');
  const list = await inbox.take();
  expect(list.t).toBe('node.list');
  return {
    nodeId: seeded.nodeId,
    nodeIdBytes: seeded.nodeIdBytes,
    ed: seeded.ed,
    nodeLink,
    hubLink,
    inbox,
  };
}

async function takeUntil(
  inbox: CtlInbox,
  t: UplinkCtlMessage['t'],
  timeoutMs = 1_000
): Promise<UplinkCtlMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await inbox.take(Math.max(10, deadline - Date.now()));
    if (msg.t === t) return msg;
  }
  throw new Error(`did not receive ${t}`);
}

describe('UplinkServer', () => {
  test('node.list 带 hub {nodeId, publicUrl}', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const hubNodeId = 'aa'.repeat(16);
      const registry = new NodeRegistry();
      const server = new UplinkServer({
        db,
        userStore,
        keyLogSource,
        registry,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          turn: null,
          nodeId: hubNodeId,
        },
        heartbeatIntervalMs: 60_000,
        authTimeoutMs: 60_000,
      });
      const node = await authNode(server, userStore, user.id);
      await server.broadcastNodeList(user.id);
      const listed = await takeUntil(node.inbox, 'node.list');
      expect(listed.t).toBe('node.list');
      if (listed.t === 'node.list') {
        expect(listed.hub).toEqual({ nodeId: hubNodeId, publicUrl: 'https://hub.example' });
      }
      expect(userStore.getHubMeta()).toEqual({
        nodeId: hubNodeId,
        publicUrl: 'https://hub.example',
      });
      server.stop();
    } finally {
      close();
    }
  });

  test('auth challenge/response 成功', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const node = await authNode(server, userStore, user.id);
      expect(server.registry.get(node.nodeId)?.authenticated).toBe(true);
      server.stop();
    } finally {
      close();
    }
  });

  test('错误私钥 auth 被拒绝', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const seeded = seedAdmittedNode(userStore, user.id);
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      const challenge = await inbox.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      const wrong = generateEd25519KeyPair();
      sendCtl(nodeLink, {
        t: 'auth.response',
        node_id: seeded.nodeId,
        sig: signAuth(wrong.secretKey, decodeBase64url(challenge.nonce)),
      });
      const closed = await hubLink.closed;
      expect(closed.reason).toBe('unauthorized');
      server.stop();
    } finally {
      close();
    }
  });

  test('revoked 证书直接断开', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const seeded = seedAdmittedNode(userStore, user.id, { revoked: true });
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      const challenge = await inbox.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(nodeLink, {
        t: 'auth.response',
        node_id: seeded.nodeId,
        sig: signAuth(seeded.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      const closed = await hubLink.closed;
      expect(closed.reason).toBe('revoked');
      server.stop();
    } finally {
      close();
    }
  });

  test('同一 node id 重复连接会替换旧链路', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const first = await authNode(server, userStore, user.id);
      const [nodeLink2, hubLink2] = createInMemoryLinkPair();
      const inbox2 = ctlInbox(nodeLink2);
      const firstClosed = first.hubLink.closed;
      server.accept(hubLink2);
      const challenge = await inbox2.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(nodeLink2, {
        t: 'auth.response',
        node_id: first.nodeId,
        sig: signAuth(first.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      await inbox2.take();
      const info = await firstClosed;
      expect(info.reason).toBe('replaced');
      expect(server.registry.get(first.nodeId)?.link).toBe(hubLink2);
      server.stop();
    } finally {
      close();
    }
  });

  test('node.status 向其他在线 node 广播 node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'alpha' });
      const b = await authNode(server, userStore, user.id, { name: 'beta' });
      const listedOnA = await takeUntil(a.inbox, 'node.list');
      expect(listedOnA.t).toBe('node.list');
      sendCtl(b.nodeLink, {
        t: 'node.status',
        version: '9.9.9',
        tmux: true,
        direct_capable: true,
        inventory: { panes: 2 },
        endpoints: [{ host: '10.1.2.3' }],
      });
      const update = await takeUntil(a.inbox, 'node.list');
      if (update.t !== 'node.list') throw new Error('expected list');
      const beta = update.nodes.find((n) => n.id === b.nodeId);
      expect(beta?.online).toBe(true);
      expect(beta?.version).toBe('9.9.9');
      expect(beta?.direct_capable).toBe(true);
      expect(userStore.getNode(b.nodeId)?.version).toBe('9.9.9');
      server.stop();
    } finally {
      close();
    }
  });

  test('心跳超时后标记离线并广播', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource, {
        heartbeatIntervalMs: 20,
        heartbeatMissLimit: 2,
      });
      const a = await authNode(server, userStore, user.id, { name: 'keep' });
      autoPong(a.nodeLink);
      const b = await authNode(server, userStore, user.id, { name: 'drop' });
      await takeUntil(a.inbox, 'node.list');
      const bClosed = b.hubLink.closed;
      const info = await bClosed;
      expect(info.reason).toBe('heartbeat-timeout');
      const update = await takeUntil(a.inbox, 'node.list', 1_000);
      if (update.t !== 'node.list') throw new Error('expected list');
      const drop = update.nodes.find((n) => n.id === b.nodeId);
      expect(drop?.online).toBe(false);
      server.stop();
    } finally {
      close();
    }
  });

  test('node.status 不能重置心跳 miss；仅匹配 outstanding ping 的 pong 才清零', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource, {
        heartbeatIntervalMs: 25,
        heartbeatMissLimit: 2,
      });
      const node = await authNode(server, userStore, user.id);
      const closed = node.hubLink.closed;
      const pump = setInterval(() => {
        sendCtl(node.nodeLink, {
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: {},
          endpoints: [],
        });
      }, 10);
      const info = await closed;
      clearInterval(pump);
      expect(info.reason).toBe('heartbeat-timeout');
      server.stop();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      close();
    }
  });

  test('key.log.req / res 与合法 append 后重播 node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const first = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      const seeded = await keyLogSource.append(user.id, first);
      expect(seeded.ok).toBe(true);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'a' });
      const b = await authNode(server, userStore, user.id, { name: 'b' });
      await takeUntil(a.inbox, 'node.list');
      sendCtl(a.nodeLink, { t: 'key.log.req', from_seq: 1 });
      const res = await takeUntil(a.inbox, 'key.log.res');
      if (res.t !== 'key.log.res') throw new Error('expected res');
      expect(res.records).toHaveLength(1);
      expect(res.records[0]?.bytes).toBe(encodeBase64url(first.bytes));

      const before = await keyLogSource.head(user.id);
      const next = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(next.bytes),
        sig: encodeBase64url(next.sig),
        id: 'append-1',
      });
      const ack = await takeUntil(a.inbox, 'key.log.ack');
      expect(ack.t).toBe('key.log.ack');
      if (ack.t === 'key.log.ack') {
        expect(ack.ok).toBe(true);
        expect(ack.id).toBe('append-1');
      }
      const update = await takeUntil(b.inbox, 'node.list');
      if (update.t !== 'node.list') throw new Error('expected list');
      const after = await keyLogSource.head(user.id);
      expect(after.seq).toBe(before.seq + 1n);
      expect(update.key_log_head.seq).toBe(Number(after.seq));
      server.stop();
    } finally {
      close();
    }
  });

  test('dead uplink send 不打断 append persist', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const first = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      expect((await keyLogSource.append(user.id, first)).ok).toBe(true);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'a' });
      const before = await keyLogSource.head(user.id);
      const next = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      a.hubLink.ctl.send = () => {
        throw new Error('dead');
      };
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(next.bytes),
        sig: encodeBase64url(next.sig),
        id: 'dead-1',
      });
      const start = Date.now();
      while (Date.now() - start < 1_000) {
        const head = await keyLogSource.head(user.id);
        if (head.seq === before.seq + 1n) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await keyLogSource.head(user.id)).seq).toBe(before.seq + 1n);
      expect(a.hubLink.closed).toBeInstanceOf(Promise);
      server.stop();
    } finally {
      close();
    }
  });

  test('相同记录重试会补跑 effects / 再广播 node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const first = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      expect((await keyLogSource.append(user.id, first)).ok).toBe(true);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'a' });
      const b = await authNode(server, userStore, user.id, { name: 'b' });
      await takeUntil(a.inbox, 'node.list');
      const next = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(next.bytes),
        sig: encodeBase64url(next.sig),
        id: 'dup-1',
      });
      const firstAck = await takeUntil(a.inbox, 'key.log.ack');
      expect(firstAck.t).toBe('key.log.ack');
      if (firstAck.t === 'key.log.ack') expect(firstAck.ok).toBe(true);
      await takeUntil(b.inbox, 'node.list');
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(next.bytes),
        sig: encodeBase64url(next.sig),
        id: 'dup-2',
      });
      const ack = await takeUntil(a.inbox, 'key.log.ack');
      expect(ack.t).toBe('key.log.ack');
      if (ack.t === 'key.log.ack') {
        expect(ack.ok).toBe(true);
        expect(ack.id).toBe('dup-2');
      }
      const update = await takeUntil(b.inbox, 'node.list');
      expect(update.t).toBe('node.list');
      server.stop();
    } finally {
      close();
    }
  });

  test('伪造 admit-node / revoke-node / rotate-root 失败且 head 不前进', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id);
      const before = await keyLogSource.head(user.id);
      const wrongRoot = rootKeyFromSeed(randomBytes(32));

      const forgedAdmit = signUserRecord(
        service,
        user.id,
        user.root,
        'admit-node',
        encodeAdmitNodePayload({
          authorization_bytes: randomBytes(8),
          authorization_sig: randomBytes(64),
          certificate_bytes: randomBytes(8),
          cert_sig: randomBytes(64),
        }),
        { signerKey: wrongRoot }
      );
      expect(await keyLogSource.append(user.id, forgedAdmit)).toEqual({
        ok: false,
        error: 'bad_signature',
      });

      const forgedRevoke = signUserRecord(
        service,
        user.id,
        user.root,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: a.nodeIdBytes, reason: 'lost' }),
        { signerKey: wrongRoot }
      );
      expect(await keyLogSource.append(user.id, forgedRevoke)).toEqual({
        ok: false,
        error: 'bad_signature',
      });

      const forgedRotateKey = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root',
        encodeRotateRootPayload({
          root_public_key: wrongRoot.publicKey,
          kdf_params: generateKdfParams(),
        }),
        { signerKey: wrongRoot }
      );
      expect(await keyLogSource.append(user.id, forgedRotateKey)).toEqual({
        ok: false,
        error: 'bad_signature',
      });

      const forgedRotateSeq = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root',
        encodeRotateRootPayload({
          root_public_key: wrongRoot.publicKey,
          kdf_params: generateKdfParams(),
        }),
        { headSeqOffset: 1n }
      );
      expect(await keyLogSource.append(user.id, forgedRotateSeq)).toEqual({
        ok: false,
        error: 'seq_gap',
      });

      const forgedRotateEpoch = signUserRecord(
        service,
        user.id,
        user.root,
        'rotate-root',
        encodeRotateRootPayload({
          root_public_key: wrongRoot.publicKey,
          kdf_params: generateKdfParams(),
        }),
        { epoch: 9 }
      );
      expect(await keyLogSource.append(user.id, forgedRotateEpoch)).toEqual({
        ok: false,
        error: 'epoch_mismatch',
      });

      expect(await keyLogSource.head(user.id)).toEqual(before);
      server.stop();
    } finally {
      close();
    }
  });

  test('合法 revoke-node 经 key.log.append 断开被撤销节点并拒绝重连', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const keeper = await authNode(server, userStore, user.id, { name: 'keep' });
      const target = await authNode(server, userStore, user.id, { name: 'drop' });
      await takeUntil(keeper.inbox, 'node.list');
      const closed = target.hubLink.closed;
      const rec = signUserRecord(
        service,
        user.id,
        user.root,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: target.nodeIdBytes, reason: 'lost' })
      );
      sendCtl(keeper.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(rec.bytes),
        sig: encodeBase64url(rec.sig),
      });
      expect((await closed).reason).toBe('revoked');
      expect(userStore.getNode(target.nodeId)?.status).toBe('revoked');
      expect(userStore.getCert(target.nodeId)?.revokedLogSeq).not.toBeNull();

      const [nodeLink2, hubLink2] = createInMemoryLinkPair();
      const inbox2 = ctlInbox(nodeLink2);
      server.accept(hubLink2);
      const challenge = await inbox2.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(nodeLink2, {
        t: 'auth.response',
        node_id: target.nodeId,
        sig: signAuth(target.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      expect((await hubLink2.closed).reason).toBe('revoked');
      server.stop();
    } finally {
      close();
    }
  });

  test('ctl 按链路串行处理：连续两条合法记录都写入', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id);
      const rec1 = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      const decoded1 = decodeKeyLogRecord(rec1.bytes);
      const rec2Record = buildKeyLogRecord(
        { seq: decoded1.seq, hash: computeRecordHash(rec1.bytes, rec1.sig) },
        decoded1.root_epoch,
        {
          uid: user.id,
          type: 'clear-totp',
          payload: encodeClearTotpPayload(),
          signer: 'root',
          credential_id: null,
        }
      );
      const rec2Bytes = encodeKeyLogRecord(rec2Record);
      const rec2 = { bytes: rec2Bytes, sig: signKeyLogRecordWithRoot(user.root, rec2Bytes) };
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(rec1.bytes),
        sig: encodeBase64url(rec1.sig),
      });
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(rec2.bytes),
        sig: encodeBase64url(rec2.sig),
      });
      await takeUntil(a.inbox, 'node.list');
      await takeUntil(a.inbox, 'node.list');
      expect((await keyLogSource.head(user.id)).seq).toBe(2n);
      server.stop();
    } finally {
      close();
    }
  });

  test('relay 双向搬字节，END/RST 传播，跨用户拒绝；授权只看 cert.userId', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const other = seedUser(userStore, { id: 'user-2', username: 'bob' });
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'a' });
      const b = await authNode(server, userStore, user.id, { name: 'b' });
      const c = await authNode(server, userStore, other.id, { name: 'c' });

      const incomingB = new Promise<LinkStream>((resolve) => b.nodeLink.onStream(resolve));
      const outA = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: b.nodeId }))
      );
      const inB = await incomingB;
      const open = JSON.parse(new TextDecoder().decode(inB.openPayload)) as {
        to: string;
        from: string;
      };
      expect(open.to).toBe(b.nodeId);
      expect(open.from).toBe(a.nodeId);

      await outA.write(new Uint8Array([1, 2, 3]));
      const readerB = inB.readable.getReader();
      const chunkB = await readerB.read();
      expect(chunkB.value?.bytes).toEqual(new Uint8Array([1, 2, 3]));

      await inB.write(new Uint8Array([9, 8]));
      const readerA = outA.readable.getReader();
      const chunkA = await readerA.read();
      expect(chunkA.value?.bytes).toEqual(new Uint8Array([9, 8]));

      outA.end();
      const restB = await readerB.read();
      expect(restB.done).toBe(true);

      const incomingB2 = new Promise<LinkStream>((resolve) => {
        b.nodeLink.onStream(resolve);
      });
      const outA2 = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: b.nodeId }))
      );
      const inB2 = await incomingB2;
      const aborted = new Promise<void>((resolve) => inB2.onAbort(resolve));
      outA2.reset('boom');
      await aborted;

      const incomingC = new Promise<LinkStream>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('should not open on C')), 200);
        c.nodeLink.onStream(() => {
          clearTimeout(timer);
          resolve(null as unknown as LinkStream);
        });
      });
      const cross = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: c.nodeId }))
      );
      const closed = await cross.closed;
      expect(closed.reason).toBe('rst');
      await expect(incomingC).rejects.toThrow('should not open on C');

      const ghost = seedAdmittedNode(userStore, user.id, { name: 'ghost-cert' });
      db.update(nodes).set({ userId: other.id }).where(eq(nodes.id, ghost.nodeId)).run();
      const ghostLink = await (async () => {
        const [nodeLink, hubLink] = createInMemoryLinkPair();
        const inbox = ctlInbox(nodeLink);
        server.accept(hubLink);
        const challenge = await inbox.take();
        if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
        sendCtl(nodeLink, {
          t: 'auth.response',
          node_id: ghost.nodeId,
          sig: signAuth(ghost.ed.secretKey, decodeBase64url(challenge.nonce)),
        });
        expect((await inbox.take()).t).toBe('auth.ok');
        await inbox.take();
        return { nodeLink, hubLink };
      })();
      const incomingGhost = new Promise<LinkStream>((resolve) =>
        ghostLink.nodeLink.onStream(resolve)
      );
      const viaCert = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: ghost.nodeId }))
      );
      const inGhost = await incomingGhost;
      expect(JSON.parse(new TextDecoder().decode(inGhost.openPayload)).from).toBe(a.nodeId);
      viaCert.end();

      const noCert = seedAdmittedNode(userStore, other.id, { name: 'no-cert-row' });
      userStore.createNode({
        id: 'ffffffffffffffffffffffffffffffff',
        userId: user.id,
        name: 'fake-nodes-row',
        now: Date.now(),
      });
      const fake = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: noCert.nodeId }))
      );
      expect((await fake.closed).reason).toBe('rst');
      const fakeRow = await a.nodeLink.openStream(
        new TextEncoder().encode(JSON.stringify({ to: 'ffffffffffffffffffffffffffffffff' }))
      );
      expect((await fakeRow.closed).reason).toBe('rst');

      server.stop();
    } finally {
      close();
    }
  });

  test('rtc.signal 路由；伪造 from:node 被拒绝；注册绑定 userId 且 TTL 过期后不再转发', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const other = seedUser(userStore, { id: 'user-2', username: 'bob' });
      let now = 1_000;
      const { server } = makeServer(db, userStore, keyLogSource, { now: () => now });
      const a = await authNode(server, userStore, user.id, { name: 'entry' });
      const b = await authNode(server, userStore, user.id, { name: 'target' });
      const c = await authNode(server, userStore, other.id, { name: 'other' });
      await takeUntil(a.inbox, 'node.list');

      const rtcSession = server.registerRtcSession({
        userId: user.id,
        browserSessionId: 'browser-1',
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        ttlMs: 50,
      });
      expect(typeof rtcSession).toBe('string');
      if (!rtcSession) throw new Error('expected rtc session');
      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'browser',
        to: b.nodeId,
        sdp: 'offer',
      });
      const forwarded = await takeUntil(b.inbox, 'rtc.signal');
      if (forwarded.t !== 'rtc.signal') throw new Error('expected signal');
      expect(forwarded.sdp).toBe('offer');
      expect(forwarded.from).toBe('browser');

      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'node',
        to: a.nodeId,
        sdp: 'spoofed',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(a.inbox.drain().some((m) => m.t === 'rtc.signal')).toBe(false);

      sendCtl(b.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'node',
        to: a.nodeId,
        candidate: 'cand',
      });
      const back = await takeUntil(a.inbox, 'rtc.signal');
      if (back.t !== 'rtc.signal') throw new Error('expected signal');
      expect(back.from).toBe('node');
      expect(back.candidate).toBe('cand');

      expect(
        server.registerRtcSession({
          userId: other.id,
          browserSessionId: 'browser-x',
          fromNodeId: a.nodeId,
          toNodeId: c.nodeId,
        })
      ).toBeNull();

      now = 1_200;
      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'browser',
        to: b.nodeId,
        sdp: 'late',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(b.inbox.drain().some((m) => m.t === 'rtc.signal' && m.sdp === 'late')).toBe(false);

      const { server: capped } = makeServer(db, userStore, keyLogSource, { rtcMaxSessions: 1 });
      const first = capped.registerRtcSession({
        userId: user.id,
        browserSessionId: 'b1',
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      });
      expect(first).not.toBeNull();
      expect(
        capped.registerRtcSession({
          userId: user.id,
          browserSessionId: 'b2',
          fromNodeId: a.nodeId,
          toNodeId: b.nodeId,
        })
      ).toBeNull();
      capped.stop();
      server.stop();
    } finally {
      close();
    }
  });

  test('forwards deterministic dc:A:B signals without prior registerRtcSession', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'entry' });
      const b = await authNode(server, userStore, user.id, { name: 'target' });
      await takeUntil(a.inbox, 'node.list');
      const lo = a.nodeId < b.nodeId ? a.nodeId : b.nodeId;
      const hi = a.nodeId < b.nodeId ? b.nodeId : a.nodeId;
      const rtcSession = `dc:${lo}:${hi}`;
      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'node',
        to: b.nodeId,
        sdp: 'dc-offer',
      });
      const forwarded = await takeUntil(b.inbox, 'rtc.signal');
      if (forwarded.t !== 'rtc.signal') throw new Error('expected signal');
      expect(forwarded.sdp).toBe('dc-offer');
      expect(forwarded.rtcSession).toBe(rtcSession);

      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession,
        from: 'browser',
        to: b.nodeId,
        sdp: 'browser-flood',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(b.inbox.drain().some((m) => m.t === 'rtc.signal' && m.sdp === 'browser-flood')).toBe(
        false
      );
      server.stop();
    } finally {
      close();
    }
  });

  test('未认证 uplink 超时关闭；stop 也会关掉未认证链接', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource, { authTimeoutMs: 40 });
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      expect((await inbox.take()).t).toBe('auth.challenge');
      expect((await hubLink.closed).reason).toBe('auth-timeout');

      const { server: stopping } = makeServer(db, userStore, keyLogSource, {
        authTimeoutMs: 60_000,
      });
      const [nodeLink2, hubLink2] = createInMemoryLinkPair();
      const inbox2 = ctlInbox(nodeLink2);
      stopping.accept(hubLink2);
      expect((await inbox2.take()).t).toBe('auth.challenge');
      const closed = hubLink2.closed;
      stopping.stop();
      expect((await closed).reason).toBe('hub-stop');
    } finally {
      close();
    }
  });

  test('oversized inventory / deep JSON / bad seq 关闭链路 protocol_error', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const node = await authNode(server, userStore, user.id);

      const closedHuge = node.hubLink.closed;
      sendRawCtl(
        node.nodeLink,
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: { blob: 'x'.repeat(4097) },
          endpoints: [],
        })
      );
      expect((await closedHuge).reason).toBe('protocol_error');

      const b = await authNode(server, userStore, user.id);
      let deep: unknown = 1;
      for (let i = 0; i < 10; i++) deep = { k: deep };
      const closedDeep = b.hubLink.closed;
      sendRawCtl(
        b.nodeLink,
        JSON.stringify({
          t: 'node.status',
          version: '1',
          tmux: false,
          direct_capable: false,
          inventory: deep,
          endpoints: [],
        })
      );
      expect((await closedDeep).reason).toBe('protocol_error');

      const c = await authNode(server, userStore, user.id);
      const closedSeq = c.hubLink.closed;
      sendRawCtl(
        c.nodeLink,
        JSON.stringify({ t: 'key.log.req', from_seq: '18446744073709551616' })
      );
      expect((await closedSeq).reason).toBe('protocol_error');
      server.stop();
    } finally {
      close();
    }
  });
});
