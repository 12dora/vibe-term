import { describe, expect, spyOn, test } from 'bun:test';
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
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import { eq } from 'drizzle-orm';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import type { UserStore } from '../auth/user-store';
import { nodes } from '../db/schema';
import {
  type CtlInbox,
  autoPong,
  createHubTestStack,
  ctlInbox,
  paddedCtlJson,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  sendRawCtl,
  signAuth,
  signUserRecord,
} from './hub-test-helpers';
import { NodeRegistry } from './node-registry';
import type { HubKeyLogSource, HubRuntimeConfig } from './types';
import { KEY_LOG_PAGE_MAX_BYTES, type UplinkCtlMessage, decodeUplinkCtl } from './uplink-protocol';
import * as uplinkProtocol from './uplink-protocol';
import {
  HUB_CTL_QUEUE_MAX,
  HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS,
  UplinkServer,
} from './uplink-server';

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
    keyLogReqStateMax?: number;
    keyLogReqIdleTtlMs?: number;
    config?: Partial<HubRuntimeConfig>;
    meshHubs?: MeshHubStore;
  }
) {
  const registry = new NodeRegistry();
  const server = new UplinkServer({
    db,
    userStore: store,
    keyLogSource: keyLog,
    registry,
    config: {
      publicUrl: 'https://hub.example',
      stun: ['stun:example:3478'],
      turn: null,
      ...extras?.config,
    },
    meshHubs: extras?.meshHubs,
    heartbeatIntervalMs: extras?.heartbeatIntervalMs ?? 60_000,
    heartbeatMissLimit: extras?.heartbeatMissLimit ?? 3,
    authTimeoutMs: extras?.authTimeoutMs ?? 60_000,
    rtcMaxSessions: extras?.rtcMaxSessions,
    now: extras?.now,
    keyLogReqStateMax: extras?.keyLogReqStateMax,
    keyLogReqIdleTtlMs: extras?.keyLogReqIdleTtlMs,
  });
  return { server, registry };
}

async function authNode(
  server: UplinkServer,
  store: UserStore,
  userId: string,
  opts?: { name?: string; revoked?: boolean; node?: ReturnType<typeof seedAdmittedNode> }
): Promise<{
  nodeId: string;
  nodeIdBytes: Uint8Array;
  ed: { secretKey: Uint8Array; publicKey: Uint8Array };
  nodeLink: LinkSession;
  hubLink: LinkSession;
  inbox: CtlInbox;
  list: UplinkCtlMessage;
}> {
  const seeded = opts?.node ?? seedAdmittedNode(store, userId, opts);
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
    list,
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

function tapCtlSend(link: LinkSession): Uint8Array[] {
  const sent: Uint8Array[] = [];
  const orig = link.ctl.send.bind(link.ctl);
  link.ctl.send = (bytes: Uint8Array) => {
    sent.push(bytes);
    orig(bytes);
  };
  return sent;
}

function nodeListPayloads(sent: Uint8Array[]): Uint8Array[] {
  return sent.filter((bytes) => {
    try {
      return decodeUplinkCtl(bytes).t === 'node.list';
    } catch {
      return false;
    }
  });
}

function nodeListCaches(server: UplinkServer): {
  lastNodeListFp: Map<string, unknown>;
  lastNodeListSent: Map<string, Uint8Array>;
} {
  return server as unknown as {
    lastNodeListFp: Map<string, unknown>;
    lastNodeListSent: Map<string, Uint8Array>;
  };
}

async function authUntilOk(
  server: UplinkServer,
  store: UserStore,
  userId: string,
  opts?: { name?: string }
): Promise<{
  nodeId: string;
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
  return { nodeId: seeded.nodeId, nodeLink, hubLink, inbox };
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
          siteName: 'hub-site',
        },
        heartbeatIntervalMs: 60_000,
        authTimeoutMs: 60_000,
      });
      const node = await authNode(server, userStore, user.id);
      const listed = node.list;
      expect(listed.t).toBe('node.list');
      if (listed.t === 'node.list') {
        expect(listed.hub).toEqual({
          nodeId: hubNodeId,
          publicUrl: 'https://hub.example',
          name: 'hub-site',
        });
        expect(listed.nodes.find((n) => n.id === hubNodeId)?.name).toBe('hub-site');
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

  test('node.list advertises hub display name from siteName in hub_meta and nodes[]', async () => {
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
          siteName: 'hub-site',
        },
        heartbeatIntervalMs: 60_000,
        authTimeoutMs: 60_000,
      });
      const node = await authNode(server, userStore, user.id, { name: 'node-a' });
      const listed = node.list;
      expect(listed.t).toBe('node.list');
      if (listed.t !== 'node.list') throw new Error('expected list');
      expect(listed.hub).toEqual({
        nodeId: hubNodeId,
        publicUrl: 'https://hub.example',
        name: 'hub-site',
      });
      expect(listed.nodes.find((n) => n.id === hubNodeId)?.name).toBe('hub-site');
      expect(listed.nodes.find((n) => n.id === node.nodeId)?.name).toBe('node-a');
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

  test('logs uplink auth rejections with a stable reason, rate-limited', async () => {
    const { db, close } = createMigratedAuthDb();
    const orig = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let now = 1_000;
      const { server } = makeServer(db, userStore, keyLogSource, { now: () => now });
      const unknownId = 'ab'.repeat(16);
      const attempt = async (nodeId: string) => {
        const [nodeLink, hubLink] = createInMemoryLinkPair();
        const inbox = ctlInbox(nodeLink);
        server.accept(hubLink);
        const challenge = await inbox.take();
        if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
        sendCtl(nodeLink, {
          t: 'auth.response',
          node_id: nodeId,
          sig: signAuth(generateEd25519KeyPair().secretKey, decodeBase64url(challenge.nonce)),
        });
        await hubLink.closed;
      };
      await attempt(unknownId);
      await attempt(unknownId);
      const first = warnings.filter((row) => row.includes('[hub][uplink] auth rejected'));
      expect(first).toHaveLength(1);
      expect(first[0]).toContain(`node=${unknownId}`);
      expect(first[0]).toContain('reason=cert_not_admitted');

      const seeded = seedAdmittedNode(userStore, user.id);
      const [badLink, badHub] = createInMemoryLinkPair();
      const badInbox = ctlInbox(badLink);
      server.accept(badHub);
      const challenge = await badInbox.take();
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(badLink, {
        t: 'auth.response',
        node_id: seeded.nodeId,
        sig: signAuth(generateEd25519KeyPair().secretKey, decodeBase64url(challenge.nonce)),
      });
      expect((await badHub.closed).reason).toBe('unauthorized');
      expect(
        warnings.some(
          (row) =>
            row.includes('[hub][uplink] auth rejected') &&
            row.includes(`node=${seeded.nodeId}`) &&
            row.includes('reason=bad_sig')
        )
      ).toBe(true);

      now += HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS;
      await attempt(unknownId);
      const later = warnings.filter(
        (row) => row.includes('auth rejected') && row.includes(`node=${unknownId}`)
      );
      expect(later).toHaveLength(2);
      expect(later[1]).toContain('suppressed=1');
      server.stop();
    } finally {
      console.warn = orig;
      close();
    }
  });

  test('non-hex auth.response.node_id is rejected at decode without logging the raw id', async () => {
    const { db, close } = createMigratedAuthDb();
    const orig = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      expect((await inbox.take()).t).toBe('auth.challenge');
      const injected = 'not-a-node\ninjected-line';
      sendRawCtl(
        nodeLink,
        JSON.stringify({
          t: 'auth.response',
          node_id: injected,
          sig: encodeBase64url(randomBytes(64)),
        })
      );
      expect((await hubLink.closed).reason).toBe('protocol_error');
      expect(warnings.some((row) => row.includes('injected-line'))).toBe(false);
      expect(warnings.some((row) => row.includes('auth rejected'))).toBe(false);
      server.stop();
    } finally {
      console.warn = orig;
      close();
    }
  });

  test('auth-reject log volume is bounded under rotating fake node ids', async () => {
    const { db, close } = createMigratedAuthDb();
    const orig = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      let now = 5_000;
      const { server } = makeServer(db, userStore, keyLogSource, { now: () => now });
      const attempt = async (nodeId: string, remoteAddress?: string) => {
        const [nodeLink, hubLink] = createInMemoryLinkPair();
        const inbox = ctlInbox(nodeLink);
        server.accept(hubLink, remoteAddress ? { remoteAddress } : undefined);
        const challenge = await inbox.take();
        if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
        sendCtl(nodeLink, {
          t: 'auth.response',
          node_id: nodeId,
          sig: signAuth(generateEd25519KeyPair().secretKey, decodeBase64url(challenge.nonce)),
        });
        await hubLink.closed;
      };
      const fakeId = (n: number) => n.toString(16).padStart(32, '0');
      for (let i = 0; i < 40; i++) {
        await attempt(fakeId(i), '203.0.113.9');
      }
      const rejected = warnings.filter((row) => row.includes('[hub][uplink] auth rejected'));
      expect(rejected.length).toBeLessThanOrEqual(20);
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.some((row) => row.includes('\n'))).toBe(false);

      now += HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS;
      await attempt(fakeId(99), '203.0.113.9');
      const after = warnings.filter((row) => row.includes('[hub][uplink] auth rejected'));
      expect(after.length).toBe(rejected.length + 1);
      expect(after[after.length - 1]).toMatch(/suppressed=\d+/);
      expect(
        Number(/suppressed=(\d+)/.exec(after[after.length - 1] ?? '')?.[1] ?? 0)
      ).toBeGreaterThan(0);
      server.stop();
    } finally {
      console.warn = orig;
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
      await new Promise((r) => setTimeout(r, 30));
      expect(b.inbox.drain().some((msg) => msg.t === 'node.list')).toBe(false);
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

  test('pre-auth 1 MiB key.log.res 关闭链路', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      expect((await inbox.take()).t).toBe('auth.challenge');
      const closed = hubLink.closed;
      sendRawCtl(
        nodeLink,
        paddedCtlJson({ t: 'key.log.res', records: [] }, KEY_LOG_PAGE_MAX_BYTES)
      );
      expect((await closed).reason).toBe('protocol_error');
      server.stop();
    } finally {
      close();
    }
  });

  test('pre-auth 非 auth.response 关闭链路', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const inbox = ctlInbox(nodeLink);
      server.accept(hubLink);
      expect((await inbox.take()).t).toBe('auth.challenge');
      const closed = hubLink.closed;
      sendCtl(nodeLink, { t: 'ping' });
      expect((await closed).reason).toBe('unauthenticated');
      server.stop();
    } finally {
      close();
    }
  });

  test('ctl 处理队列溢出关闭链路', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore } = createHubTestStack(db);
      const user = seedUser(userStore);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source: HubKeyLogSource = {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async list() {
          await gate;
          return [];
        },
        async append() {
          return { ok: false, error: 'readonly' };
        },
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      const closed = node.hubLink.closed;
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1 });
      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < HUB_CTL_QUEUE_MAX + 8; i++) {
        sendCtl(node.nodeLink, { t: 'ping' });
      }
      expect((await closed).reason).toBe('ctl-overflow');
      release();
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

  test('rate-limits key.log.req per node with a token bucket', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let listCalls = 0;
      const counted: HubKeyLogSource = {
        head: (userId) => keyLogSource.head(userId),
        list: async (userId, fromSeq) => {
          listCalls += 1;
          return keyLogSource.list(userId, fromSeq);
        },
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, counted);
      const node = await authNode(server, userStore, user.id);
      node.inbox.drain();
      for (let i = 0; i < 21; i++) {
        sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: `req-${i}` });
      }
      let got = 0;
      const responses: UplinkCtlMessage[] = [];
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && got < 21) {
        try {
          const msg = await node.inbox.take(40);
          if (msg.t === 'key.log.res') {
            got += 1;
            responses.push(msg);
          }
        } catch {
          break;
        }
      }
      expect(listCalls).toBe(20);
      expect(got).toBe(21);
      const last = responses[responses.length - 1];
      expect(last && last.t === 'key.log.res' ? last.error : undefined).toBe('rate_limited');
      expect(last && last.t === 'key.log.res' ? last.retry_after_ms : undefined).toBeGreaterThan(0);
      server.stop();
    } finally {
      close();
    }
  });

  test('aggregates key.log.req warn logs with a suppressed count', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let now = 1_000;
      const warnings: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      const { server } = makeServer(db, userStore, keyLogSource, { now: () => now });
      const node = await authNode(server, userStore, user.id);
      node.inbox.drain();
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'a' });
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'b' });
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'c' });
      await node.inbox.take();
      await node.inbox.take();
      await node.inbox.take();
      const first = warnings.filter((row) => row.includes('key.log.req'));
      expect(first).toHaveLength(1);
      expect(first[0]).not.toContain('suppressed=');
      now += 10_000;
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'd' });
      await node.inbox.take();
      const later = warnings.filter((row) => row.includes('key.log.req'));
      expect(later).toHaveLength(2);
      expect(later[1]).toContain('suppressed=2');
      console.warn = orig;
      server.stop();
    } finally {
      close();
    }
  });

  test('key.log.req buckets are LRU+TTL, survive reconnect, clear on stop, and drop on revoke', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let now = 1_000;
      let listCalls = 0;
      const counted: HubKeyLogSource = {
        head: (userId) => keyLogSource.head(userId),
        list: async (userId, fromSeq) => {
          listCalls += 1;
          return keyLogSource.list(userId, fromSeq);
        },
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, counted, {
        now: () => now,
        keyLogReqStateMax: 2,
        keyLogReqIdleTtlMs: 5_000,
      });
      const node = await authNode(server, userStore, user.id);
      node.inbox.drain();
      for (let i = 0; i < 20; i++) {
        sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: `burst-${i}` });
      }
      let got = 0;
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && got < 20) {
        try {
          const msg = await node.inbox.take(40);
          if (msg.t === 'key.log.res') got += 1;
        } catch {
          break;
        }
      }
      expect(got).toBe(20);
      expect(listCalls).toBe(20);
      node.nodeLink.close('reconnect');
      await node.hubLink.closed;

      const [nodeLink2, hubLink2] = createInMemoryLinkPair();
      const inbox2 = ctlInbox(nodeLink2);
      server.accept(hubLink2);
      const challenge = await inbox2.take();
      expect(challenge.t).toBe('auth.challenge');
      if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
      sendCtl(nodeLink2, {
        t: 'auth.response',
        node_id: node.nodeId,
        sig: signAuth(node.ed.secretKey, decodeBase64url(challenge.nonce)),
      });
      await inbox2.take();
      await inbox2.take();
      inbox2.drain();
      sendCtl(nodeLink2, { t: 'key.log.req', from_seq: 1, id: 'after-reconnect' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(listCalls).toBe(20);

      const otherA = await authNode(server, userStore, user.id);
      const otherB = await authNode(server, userStore, user.id);
      otherA.inbox.drain();
      otherB.inbox.drain();
      sendCtl(otherA.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'lru-a' });
      sendCtl(otherB.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'lru-b' });
      await otherA.inbox.take();
      await otherB.inbox.take();
      expect(server.keyLogReqBucketCount).toBeLessThanOrEqual(2);

      now += 5_001;
      sendCtl(otherB.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'ttl-sweep' });
      await otherB.inbox.take();
      expect(server.keyLogReqBucketCount).toBe(1);

      const victim = await authNode(server, userStore, user.id);
      victim.inbox.drain();
      sendCtl(victim.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'pre-revoke' });
      await victim.inbox.take();
      const cert = userStore.getCert(victim.nodeId);
      if (!cert) throw new Error('missing cert');
      userStore.upsertCert({ ...cert, revokedLogSeq: 9 });
      sendCtl(victim.nodeLink, { t: 'ping' });
      await victim.hubLink.closed;
      expect(server.keyLogReqBucketCount).toBe(1);

      server.stop();
      expect(server.keyLogReqBucketCount).toBe(0);
    } finally {
      close();
    }
  });

  test('key.log.req pages records and sets has_more', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore } = createHubTestStack(db);
      const user = seedUser(userStore);
      const recBytes = encodeBase64url(new Uint8Array([1, 2, 3]));
      const recSig = encodeBase64url(randomBytes(64));
      const rows = Array.from({ length: 300 }, (_, i) => ({
        seq: BigInt(i + 1),
        bytes: decodeBase64url(recBytes),
        sig: decodeBase64url(recSig),
      }));
      const source: HubKeyLogSource = {
        async head() {
          return { seq: 300n, hash: new Uint8Array(32) };
        },
        async list(_userId, fromSeq, limit) {
          const from = Number(fromSeq ?? 1n);
          const start = Math.max(0, from - 1);
          const cap = limit ?? rows.length;
          return rows.slice(start, start + cap);
        },
        async append() {
          return { ok: false, error: 'readonly' };
        },
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      node.inbox.drain();
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'page-1', limit: 256 });
      const res = await takeUntil(node.inbox, 'key.log.res');
      expect(res.t).toBe('key.log.res');
      if (res.t !== 'key.log.res') throw new Error('expected res');
      expect(res.records).toHaveLength(256);
      expect(res.has_more).toBe(true);
      server.stop();
    } finally {
      close();
    }
  });

  test('stop() waits for an in-flight key.log.append before resolving', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore } = createHubTestStack(db);
      const user = seedUser(userStore);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let appendFinished = false;
      const started = Promise.withResolvers<void>();
      const source: HubKeyLogSource = {
        async head() {
          return { seq: 0n, hash: new Uint8Array(32) };
        },
        async list() {
          return [];
        },
        async append() {
          started.resolve();
          await gate;
          appendFinished = true;
          return { ok: false, error: 'readonly' };
        },
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      sendCtl(node.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(new Uint8Array([1, 2, 3])),
        sig: encodeBase64url(randomBytes(64)),
        id: 'drain-1',
      });
      await started.promise;
      let stopResolved = false;
      const stopping = Promise.resolve(server.stop()).then(() => {
        stopResolved = true;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(appendFinished).toBe(false);
      expect(stopResolved).toBe(false);
      release();
      await stopping;
      expect(appendFinished).toBe(true);
      expect(stopResolved).toBe(true);
    } finally {
      close();
    }
  });

  test('broadcastNodeList encodes once and reuses bytes across N links', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const a = await authNode(server, userStore, user.id, { name: 'a' });
      const b = await authNode(server, userStore, user.id, { name: 'b' });
      const c = await authNode(server, userStore, user.id, { name: 'c' });
      a.inbox.drain();
      b.inbox.drain();
      c.inbox.drain();
      const taps = [a, b, c].map((n) => tapCtlSend(n.hubLink));
      const encode = spyOn(uplinkProtocol, 'encodeUplinkCtl');
      sendCtl(a.nodeLink, {
        t: 'node.status',
        version: '2.0.0',
        tmux: false,
        direct_capable: false,
        inventory: { panes: 4 },
        endpoints: [],
      });
      await takeUntil(b.inbox, 'node.list');
      const lists = taps.flatMap(nodeListPayloads);
      expect(lists).toHaveLength(3);
      expect(lists.every((bytes) => bytes === lists[0])).toBe(true);
      expect(encode.mock.calls.filter(([msg]) => msg.t === 'node.list')).toHaveLength(1);
      encode.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('broadcastNodeList skips send when the projected list is unchanged', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const { server } = makeServer(db, userStore, keyLogSource);
      const node = await authNode(server, userStore, user.id);
      const sent = tapCtlSend(node.hubLink);
      await server.broadcastNodeList(user.id);
      expect(nodeListPayloads(sent)).toHaveLength(0);
      await server.broadcastNodeList(user.id);
      expect(nodeListPayloads(sent)).toHaveLength(0);
      server.stop();
    } finally {
      close();
    }
  });

  test('auth does not receive a cached node.list when keyLogSource.head() fails', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let failHead = false;
      const source: HubKeyLogSource = {
        head: async (userId) => {
          if (failHead) throw new Error('head failed');
          return keyLogSource.head(userId);
        },
        list: (userId, fromSeq, limit) => keyLogSource.list(userId, fromSeq, limit),
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, source);
      await authNode(server, userStore, user.id, { name: 'a' });
      expect(nodeListCaches(server).lastNodeListSent.has(user.id)).toBe(true);
      failHead = true;
      const b = await authUntilOk(server, userStore, user.id, { name: 'b' });
      await new Promise((r) => setTimeout(r, 40));
      expect(b.inbox.drain().some((msg) => msg.t === 'node.list')).toBe(false);
      failHead = false;
      const result = await server.broadcastNodeList(user.id);
      expect(result).toBe('sent');
      const list = await b.inbox.take();
      expect(list.t).toBe('node.list');
      server.stop();
    } finally {
      close();
    }
  });

  test('last authenticated link close drops the per-user node.list cache without rebuilding', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let heads = 0;
      const source: HubKeyLogSource = {
        head: async (userId) => {
          heads += 1;
          return keyLogSource.head(userId);
        },
        list: (userId, fromSeq, limit) => keyLogSource.list(userId, fromSeq, limit),
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      expect(nodeListCaches(server).lastNodeListSent.has(user.id)).toBe(true);
      expect(nodeListCaches(server).lastNodeListFp.has(user.id)).toBe(true);
      const headsAfterAuth = heads;
      node.nodeLink.close();
      await node.hubLink.closed;
      expect(heads).toBe(headsAfterAuth);
      expect(nodeListCaches(server).lastNodeListSent.has(user.id)).toBe(false);
      expect(nodeListCaches(server).lastNodeListFp.has(user.id)).toBe(false);
      server.stop();
    } finally {
      close();
    }
  });

  test('key.log.req byte-limit paging encodes key.log.res once', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore } = createHubTestStack(db);
      const user = seedUser(userStore);
      const payload = new Uint8Array(700_000).fill(7);
      const sig = new Uint8Array(64).fill(9);
      const rows = Array.from({ length: 2 }, (_, i) => ({
        seq: BigInt(i + 1),
        bytes: payload,
        sig,
      }));
      const source: HubKeyLogSource = {
        async head() {
          return { seq: 2n, hash: new Uint8Array(32) };
        },
        async list() {
          return rows;
        },
        async append() {
          return { ok: false, error: 'readonly' };
        },
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      const sent = tapCtlSend(node.hubLink);
      const encode = spyOn(uplinkProtocol, 'encodeUplinkCtl');
      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1, id: 'once-1', limit: 256 });
      await waitFor(() => sent.some((bytes) => bytes.byteLength > 0));
      const resCalls = encode.mock.calls.filter(([msg]) => msg.t === 'key.log.res');
      expect(resCalls).toHaveLength(1);
      const res = resCalls[0]?.[0];
      expect(res && res.t === 'key.log.res' ? res.has_more : undefined).toBe(true);
      expect(res && res.t === 'key.log.res' ? res.records.length : -1).toBeLessThan(2);
      encode.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('interleaved slow/fast node.list builds keep newest head and monotonic version', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      let seq = 1n;
      const hold = Promise.withResolvers<void>();
      let stallNext = false;
      let heads = 0;
      const hashFor = (s: bigint): Uint8Array => {
        const h = new Uint8Array(32);
        h[0] = Number(s);
        return h;
      };
      const source: HubKeyLogSource = {
        async head() {
          heads += 1;
          const snap = { seq, hash: hashFor(seq) };
          if (stallNext) {
            stallNext = false;
            await hold.promise;
            return snap;
          }
          return snap;
        },
        list: (userId, fromSeq, limit) => keyLogSource.list(userId, fromSeq, limit),
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, source);
      const node = await authNode(server, userStore, user.id);
      const sent = tapCtlSend(node.hubLink);
      const headsAfterAuth = heads;
      stallNext = true;
      const slow = server.broadcastNodeList(user.id);
      await waitFor(() => heads > headsAfterAuth);
      seq = 2n;
      const fast = server.broadcastNodeList(user.id);
      hold.resolve();
      await Promise.all([slow, fast]);
      const lists = nodeListPayloads(sent).map((bytes) => decodeUplinkCtl(bytes));
      const versions = lists.map((msg) => {
        if (msg.t !== 'node.list') throw new Error('expected node.list');
        return msg.version;
      });
      for (let i = 1; i < versions.length; i++) {
        expect(versions[i]).toBeGreaterThan(versions[i - 1]);
      }
      const cached = nodeListCaches(server).lastNodeListSent.get(user.id);
      expect(cached).toBeDefined();
      const finalList = decodeUplinkCtl(cached as Uint8Array);
      expect(finalList.t).toBe('node.list');
      if (finalList.t !== 'node.list') throw new Error('expected node.list');
      expect(finalList.key_log_head.seq).toBe(2);
      expect(finalList.version).toBe(versions[versions.length - 1] ?? finalList.version);
      server.stop();
    } finally {
      close();
    }
  });

  test('burst of node.list triggers coalesces to a bounded number of rebuilds', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const hold = Promise.withResolvers<void>();
      let heads = 0;
      let gateHeads = false;
      const source: HubKeyLogSource = {
        async head() {
          heads += 1;
          if (gateHeads) await hold.promise;
          return keyLogSource.head(user.id);
        },
        list: (userId, fromSeq, limit) => keyLogSource.list(userId, fromSeq, limit),
        append: (userId, record) => keyLogSource.append(userId, record),
      };
      const { server } = makeServer(db, userStore, source);
      await authNode(server, userStore, user.id);
      const headsAfterAuth = heads;
      gateHeads = true;
      const first = server.broadcastNodeList(user.id);
      await waitFor(() => heads > headsAfterAuth);
      const burst = Array.from({ length: 20 }, () => server.broadcastNodeList(user.id));
      hold.resolve();
      await Promise.all([first, ...burst]);
      expect(heads - headsAfterAuth).toBeLessThanOrEqual(2);
      expect(heads - headsAfterAuth).toBeGreaterThanOrEqual(1);
      server.stop();
    } finally {
      close();
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timeout');
}

const SELF_HUB = 'aa'.repeat(16);

function sendHubStatus(
  link: Parameters<typeof sendCtl>[0],
  hub: {
    publicUrl: string;
    mode: 'active' | 'standby';
    priority: number;
    writerEpoch: number;
    caFingerprint?: string | null;
  }
): void {
  sendCtl(link, {
    t: 'node.status',
    version: '1.1.11',
    tmux: false,
    direct_capable: false,
    inventory: {},
    endpoints: [],
    hub,
  });
}

describe('UplinkServer multi-hub', () => {
  test('启动时写入自身 hub 行；node.status 广告 upsert，断线标记 offline', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const meshHubs = new MeshHubStore(db);
      let now = 1_000;
      const peer = seedAdmittedNode(userStore, user.id, { name: 'standby-hub' });
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        now: () => now,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          authorizedHubIds: [peer.nodeId],
        },
      });
      const self = meshHubs.get(SELF_HUB);
      expect(self).not.toBeNull();
      expect(self?.mode).toBe('active');
      expect(self?.priority).toBe(100);
      expect(self?.writerEpoch).toBe(1);
      expect(self?.publicUrl).toBe('https://hub.example');
      expect(self?.online).toBe(true);

      const node = await authNode(server, userStore, user.id, { node: peer });
      now = 2_000;
      sendHubStatus(node.nodeLink, {
        publicUrl: 'https://standby.example',
        mode: 'standby',
        priority: 200,
        writerEpoch: 1,
      });
      await takeUntil(node.inbox, 'node.list');
      const advertised = meshHubs.get(node.nodeId);
      expect(advertised).not.toBeNull();
      expect(advertised?.publicUrl).toBe('https://standby.example');
      expect(advertised?.mode).toBe('standby');
      expect(advertised?.priority).toBe(200);
      expect(advertised?.writerEpoch).toBe(1);
      expect(advertised?.online).toBe(true);
      expect(advertised?.lastSeenAt).toBe(2_000);

      now = 3_000;
      node.nodeLink.close();
      await node.hubLink.closed;
      expect(meshHubs.get(node.nodeId)?.online).toBe(false);
      expect(meshHubs.get(SELF_HUB)?.online).toBe(true);
      server.stop();
    } finally {
      close();
    }
  });

  test('node.list 带 hubs/writerHubId，legacy hub 指向 writer', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const meshHubs = new MeshHubStore(db);
      const peer = seedAdmittedNode(userStore, user.id, { name: 'peer' });
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 100,
          writerEpoch: 4,
          authorizedHubIds: [peer.nodeId],
        },
      });
      const node = await authNode(server, userStore, user.id, { node: peer });
      sendHubStatus(node.nodeLink, {
        publicUrl: 'https://standby.example',
        mode: 'standby',
        priority: 200,
        writerEpoch: 1,
      });
      const listed = await takeUntil(node.inbox, 'node.list');
      expect(listed.t).toBe('node.list');
      if (listed.t !== 'node.list') throw new Error('expected list');
      expect(listed.writerHubId).toBe(SELF_HUB);
      expect(listed.writerEpoch).toBe(4);
      expect(listed.hub).toEqual({
        nodeId: SELF_HUB,
        publicUrl: 'https://hub.example',
        name: 'hub-site',
      });
      expect(listed.hubs?.map((h) => h.nodeId).sort()).toEqual([SELF_HUB, node.nodeId].sort());
      const selfRow = listed.hubs?.find((h) => h.nodeId === SELF_HUB);
      expect(selfRow).toMatchObject({
        publicUrl: 'https://hub.example',
        mode: 'active',
        priority: 100,
        writerEpoch: 4,
        online: true,
      });
      const standbyRow = listed.hubs?.find((h) => h.nodeId === node.nodeId);
      expect(standbyRow).toMatchObject({
        publicUrl: 'https://standby.example',
        mode: 'standby',
        priority: 200,
        writerEpoch: 1,
        online: true,
      });
      server.stop();
    } finally {
      close();
    }
  });

  test('standby 的 legacy hub 指向已知 writer', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const writerId = 'bb'.repeat(16);
      const meshHubs = new MeshHubStore(db);
      meshHubs.upsert(
        {
          hubNodeId: writerId,
          publicUrl: 'https://writer.example',
          name: 'writer',
          mode: 'active',
          priority: 50,
          writerEpoch: 9,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'standby-site',
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          authorizedHubIds: [writerId],
        },
      });
      const node = await authNode(server, userStore, user.id);
      expect(node.list.t).toBe('node.list');
      if (node.list.t !== 'node.list') throw new Error('expected list');
      expect(node.list.writerHubId).toBe(writerId);
      expect(node.list.writerEpoch).toBe(9);
      expect(node.list.hub).toEqual({
        nodeId: writerId,
        publicUrl: 'https://writer.example',
        name: 'writer',
      });
      expect(server.mode()).toBe('standby');
      server.stop();
    } finally {
      close();
    }
  });

  test('未授权高 epoch active 广告不 fencing、不进 hubs、不变 writer', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const meshHubs = new MeshHubStore(db);
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
        },
      });
      const ignored: string[] = [];
      const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        ignored.push(String(args[0]));
      });
      const node = await authNode(server, userStore, user.id);
      expect(server.mode()).toBe('active');
      sendHubStatus(node.nodeLink, {
        publicUrl: 'https://attacker.example',
        mode: 'active',
        priority: 10,
        writerEpoch: 7,
        caFingerprint: 'ab'.repeat(32),
      });
      const listed = await takeUntil(node.inbox, 'node.list');
      expect(server.mode()).toBe('active');
      expect(meshHubs.get(node.nodeId)).toBeNull();
      expect(meshHubs.get(SELF_HUB)?.mode).toBe('active');
      expect(listed.t).toBe('node.list');
      if (listed.t !== 'node.list') throw new Error('expected list');
      expect(listed.writerHubId).toBe(SELF_HUB);
      expect(listed.writerEpoch).toBe(1);
      expect(listed.hubs?.some((h) => h.nodeId === node.nodeId)).toBe(false);
      expect(listed.hubs?.some((h) => h.caFingerprint === 'ab'.repeat(32))).toBe(false);
      expect(
        ignored.some((line) =>
          line.includes(`[hub] ignored hub advertisement from unauthorized node=${node.nodeId}`)
        )
      ).toBe(true);
      warn.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('授权的更高 writerEpoch active 广告仍 fencing 降级并重播', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const meshHubs = new MeshHubStore(db);
      const peer = seedAdmittedNode(userStore, user.id);
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          authorizedHubIds: [peer.nodeId],
        },
      });
      const logged: string[] = [];
      const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]));
      });
      const node = await authNode(server, userStore, user.id, { node: peer });
      expect(server.mode()).toBe('active');
      sendHubStatus(node.nodeLink, {
        publicUrl: 'https://new-writer.example',
        mode: 'active',
        priority: 10,
        writerEpoch: 7,
      });
      const listed = await takeUntil(node.inbox, 'node.list');
      expect(server.mode()).toBe('standby');
      expect(logged.some((line) => line.includes('[hub] fenced:'))).toBe(true);
      expect(logged.some((line) => line.includes('writerEpoch=7'))).toBe(true);
      expect(logged.some((line) => line.includes(`hub=${node.nodeId}`))).toBe(true);
      expect(listed.t).toBe('node.list');
      if (listed.t !== 'node.list') throw new Error('expected list');
      expect(listed.writerHubId).toBe(node.nodeId);
      expect(listed.writerEpoch).toBe(7);
      expect(listed.hub?.nodeId).toBe(node.nodeId);
      expect(listed.hub?.publicUrl).toBe('https://new-writer.example');
      expect(meshHubs.get(SELF_HUB)?.mode).toBe('standby');
      error.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('同等 epoch 的另一个授权 active 每 60s 打一次 split-brain 警告且不降级', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const peer = seedAdmittedNode(userStore, user.id);
      let now = 10_000;
      const { server } = makeServer(db, userStore, keyLogSource, {
        now: () => now,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          mode: 'active',
          priority: 100,
          writerEpoch: 3,
          authorizedHubIds: [peer.nodeId],
        },
      });
      const warns: string[] = [];
      const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warns.push(String(args[0]));
      });
      const node = await authNode(server, userStore, user.id, { node: peer });
      const ad = {
        publicUrl: 'https://other.example',
        mode: 'active' as const,
        priority: 80,
        writerEpoch: 3,
      };
      sendHubStatus(node.nodeLink, ad);
      await takeUntil(node.inbox, 'node.list');
      sendHubStatus(node.nodeLink, ad);
      await new Promise((r) => setTimeout(r, 30));
      const splitBrain = () => warns.filter((line) => line.includes('split-brain'));
      expect(splitBrain()).toHaveLength(1);
      expect(server.mode()).toBe('active');

      now = 10_000 + 60_000;
      sendHubStatus(node.nodeLink, ad);
      await takeUntil(node.inbox, 'node.list');
      expect(splitBrain()).toHaveLength(2);
      expect(server.mode()).toBe('active');
      warn.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('重启后若 store 中已有更高 epoch 的授权 active 则保持 standby', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      seedUser(userStore);
      const writerId = 'bb'.repeat(16);
      const meshHubs = new MeshHubStore(db);
      meshHubs.upsert(
        {
          hubNodeId: writerId,
          publicUrl: 'https://writer.example',
          name: 'writer',
          mode: 'active',
          priority: 50,
          writerEpoch: 7,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      meshHubs.upsert(
        {
          hubNodeId: SELF_HUB,
          publicUrl: 'https://hub.example',
          name: 'hub-site',
          mode: 'standby',
          priority: 100,
          writerEpoch: 1,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const logged: string[] = [];
      const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]));
      });
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          nodeId: SELF_HUB,
          hubNodeId: SELF_HUB,
          siteName: 'hub-site',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          authorizedHubIds: [writerId],
        },
      });
      expect(server.mode()).toBe('standby');
      expect(meshHubs.get(SELF_HUB)?.mode).toBe('standby');
      expect(logged.some((line) => line.includes('[hub] starting fenced:'))).toBe(true);
      error.mockRestore();
      server.stop();
    } finally {
      close();
    }
  });

  test('standby 拒绝延长 key log 的 append，相同记录重放仍 ack', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource, service } = createHubTestStack(db);
      const user = seedUser(userStore);
      const writerId = 'bb'.repeat(16);
      const meshHubs = new MeshHubStore(db);
      meshHubs.upsert(
        {
          hubNodeId: writerId,
          publicUrl: 'https://writer.example',
          name: 'writer',
          mode: 'active',
          priority: 50,
          writerEpoch: 5,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const first = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      expect((await keyLogSource.append(user.id, first)).ok).toBe(true);
      const { server } = makeServer(db, userStore, keyLogSource, {
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: ['stun:example:3478'],
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: SELF_HUB,
          nodeId: SELF_HUB,
          authorizedHubIds: [writerId],
        },
      });
      const node = await authNode(server, userStore, user.id);
      const sent = tapCtlSend(node.hubLink);
      const before = await keyLogSource.head(user.id);
      const next = signUserRecord(
        service,
        user.id,
        user.root,
        'clear-totp',
        encodeClearTotpPayload()
      );
      sendCtl(node.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(next.bytes),
        sig: encodeBase64url(next.sig),
        id: 'catch-up-1',
      });
      const ack = await takeUntil(node.inbox, 'key.log.ack');
      expect(ack.t).toBe('key.log.ack');
      if (ack.t === 'key.log.ack') {
        expect(ack.ok).toBe(false);
        expect(ack.error).toBe(HUB_NOT_WRITER);
        expect(ack.id).toBe('catch-up-1');
      }
      expect((await keyLogSource.head(user.id)).seq).toBe(before.seq);
      const rawAck = sent
        .map((bytes) => {
          try {
            return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((msg) => msg?.t === 'key.log.ack');
      expect(rawAck).toMatchObject({
        t: 'key.log.ack',
        ok: false,
        error: HUB_NOT_WRITER,
        writerHubId: writerId,
        writerPublicUrl: 'https://writer.example',
        writerEpoch: 5,
      });

      sendCtl(node.nodeLink, {
        t: 'key.log.append',
        bytes: encodeBase64url(first.bytes),
        sig: encodeBase64url(first.sig),
        id: 'replay-1',
      });
      const replay = await takeUntil(node.inbox, 'key.log.ack');
      expect(replay.t).toBe('key.log.ack');
      if (replay.t === 'key.log.ack') {
        expect(replay.ok).toBe(true);
        expect(replay.id).toBe('replay-1');
      }
      expect((await keyLogSource.head(user.id)).seq).toBe(before.seq);

      sendCtl(node.nodeLink, { t: 'key.log.req', from_seq: 1 });
      const res = await takeUntil(node.inbox, 'key.log.res');
      expect(res.t).toBe('key.log.res');
      if (res.t === 'key.log.res') expect(res.records.length).toBeGreaterThan(0);
      server.stop();
    } finally {
      close();
    }
  });
});
