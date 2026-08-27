import { describe, expect, test } from 'bun:test';
import {
  decodeBase64url,
  encodeBase64url,
  generateEd25519KeyPair,
  randomBytes,
} from '@tmex/shared/auth';
import { type LinkSession, type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import {
  type CtlInbox,
  MemoryHubKeyLog,
  autoPong,
  ctlInbox,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  signAuth,
} from './hub-test-helpers';
import { NodeRegistry } from './node-registry';
import type { UplinkCtlMessage } from './uplink-protocol';
import { UplinkServer } from './uplink-server';

function makeServer(
  db: ReturnType<typeof createMigratedAuthDb>['db'],
  store: UserStore,
  keyLog: MemoryHubKeyLog,
  extras?: { heartbeatIntervalMs?: number; heartbeatMissLimit?: number }
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
  return { nodeId: seeded.nodeId, ed: seeded.ed, nodeLink, hubLink, inbox };
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
  test('auth challenge/response 成功', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const node = await authNode(server, store, user.id);
      expect(server.registry.get(node.nodeId)?.authenticated).toBe(true);
      server.stop();
    } finally {
      close();
    }
  });

  test('错误私钥 auth 被拒绝', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const seeded = seedAdmittedNode(store, user.id);
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
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const seeded = seedAdmittedNode(store, user.id, { revoked: true });
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
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const first = await authNode(server, store, user.id);
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
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const a = await authNode(server, store, user.id, { name: 'alpha' });
      const b = await authNode(server, store, user.id, { name: 'beta' });
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
      expect(store.getNode(b.nodeId)?.version).toBe('9.9.9');
      server.stop();
    } finally {
      close();
    }
  });

  test('心跳超时后标记离线并广播', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog, {
        heartbeatIntervalMs: 20,
        heartbeatMissLimit: 2,
      });
      const a = await authNode(server, store, user.id, { name: 'keep' });
      autoPong(a.nodeLink);
      const b = await authNode(server, store, user.id, { name: 'drop' });
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

  test('key.log.req / res 与 append 后重播 node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const recBytes = randomBytes(16);
      const recSig = randomBytes(64);
      keyLog.seed(user.id, [{ bytes: recBytes, sig: recSig }]);
      const { server } = makeServer(db, store, keyLog);
      const a = await authNode(server, store, user.id, { name: 'a' });
      const b = await authNode(server, store, user.id, { name: 'b' });
      await takeUntil(a.inbox, 'node.list');
      sendCtl(a.nodeLink, { t: 'key.log.req', from_seq: 1 });
      const res = await takeUntil(a.inbox, 'key.log.res');
      if (res.t !== 'key.log.res') throw new Error('expected res');
      expect(res.records).toHaveLength(1);
      expect(res.records[0]?.bytes).toBe(encodeBase64url(recBytes));

      const before = await keyLog.head(user.id);
      sendCtl(a.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(randomBytes(8)),
        sig: encodeBase64url(randomBytes(64)),
      });
      const update = await takeUntil(b.inbox, 'node.list');
      if (update.t !== 'node.list') throw new Error('expected list');
      const after = await keyLog.head(user.id);
      expect(after.seq).toBe(before.seq + 1n);
      expect(update.key_log_head.seq).toBe(Number(after.seq));
      server.stop();
    } finally {
      close();
    }
  });

  test('relay 双向搬字节，END/RST 传播，跨用户拒绝', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const other = seedUser(store, { id: 'user-2', username: 'bob' });
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const a = await authNode(server, store, user.id, { name: 'a' });
      const b = await authNode(server, store, user.id, { name: 'b' });
      const c = await authNode(server, store, other.id, { name: 'c' });

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

      server.stop();
    } finally {
      close();
    }
  });

  test('rtc.signal 路由；伪造 from:node 被拒绝', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      const user = seedUser(store);
      const keyLog = new MemoryHubKeyLog();
      const { server } = makeServer(db, store, keyLog);
      const a = await authNode(server, store, user.id, { name: 'entry' });
      const b = await authNode(server, store, user.id, { name: 'target' });
      await takeUntil(a.inbox, 'node.list');

      server.registerRtcSession('rtc-1', { fromNodeId: a.nodeId, toNodeId: b.nodeId });
      sendCtl(a.nodeLink, {
        t: 'rtc.signal',
        rtcSession: 'rtc-1',
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
        rtcSession: 'rtc-1',
        from: 'node',
        to: a.nodeId,
        sdp: 'spoofed',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(a.inbox.drain().some((m) => m.t === 'rtc.signal')).toBe(false);

      sendCtl(b.nodeLink, {
        t: 'rtc.signal',
        rtcSession: 'rtc-1',
        from: 'node',
        to: a.nodeId,
        candidate: 'cand',
      });
      const back = await takeUntil(a.inbox, 'rtc.signal');
      if (back.t !== 'rtc.signal') throw new Error('expected signal');
      expect(back.from).toBe('node');
      expect(back.candidate).toBe('cand');
      server.stop();
    } finally {
      close();
    }
  });
});
