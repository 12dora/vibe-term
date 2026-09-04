// 中继模式下 `POST /api/auth/keylog?hub=sync` 的本地优先落账。
//
// 中继设计里本地成员表 / 密钥日志才是权威，中继的注册表只是可重建缓存（plan §1.4 / §1.12），
// 因此 `hub=sync` 永远不能等中继确认——否则三条路都会死锁：
//   (a) 首次接入：还没有中继可问，`set-relays` 里的令牌就是接下来要用的那把；
//   (b) 改密踢出后重新接入：旧令牌已作废、链路已断，新令牌只存在于这条还没落账的记录里；
//   (c) hub → 中继迁移：旧 hub 可能根本不认识 `set-relays`（minVersion 1.1.23）。

import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
  buildKeyLogRecord,
  canonicalHubUrl,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  generateKdfParams,
  hexToBytes,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { generateTenantKey } from '@tmex/shared/relay';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import type { AuthKeyLogPublisher } from './auth-routes';
import { challengeAndLogin } from './auth-routes.test';
import { MeshHttpRuntime } from './mesh-http';
import { buildMetaKeyPayload, buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';
import { createRelayWiring } from './relay-wiring';
import type { AttachedHub } from './uplink-pool';

const RELAY_URL = 'https://relay.example';
const RELAY_URL_2 = 'https://relay2.example';
const TENANT_ID = 'ab'.repeat(16);
const PASSWORD = 'relay-pass-1234';
/** 首次接入仍走 hub 模式的 `nodes.version`；中继记录要求全员 ≥ 1.1.23。 */
const NODE_VERSION = '1.1.23';
const PEER_ID = 'bb'.repeat(16);

type PublisherSpy = AuthKeyLogPublisher & {
  readonly published: Array<{ bytes: Uint8Array; sig: Uint8Array }>;
  readonly acked: Array<{ bytes: Uint8Array; sig: Uint8Array }>;
};

function offlinePublisher(): PublisherSpy {
  const published: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  const acked: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  return {
    published,
    acked,
    publish(record) {
      published.push(record);
      // UplinkPool.requireLive()：没有活跃上级时直接抛
      throw new Error('uplink is not online');
    },
    async publishAndAck(record) {
      acked.push(record);
      throw new Error('uplink is not online');
    },
  };
}

function livePublisher(): PublisherSpy {
  const published: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  const acked: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  return {
    published,
    acked,
    publish(record) {
      published.push(record);
    },
    async publishAndAck(record) {
      acked.push(record);
      return { ok: true as const, seq: 0n };
    },
  };
}

async function boot(opts?: {
  publisher?: PublisherSpy;
  attachedHub?: () => AttachedHub | null;
  roles?: { hub: boolean; node: boolean; relay: boolean };
}) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore,
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await keyLogService.bootstrapUserWithSelfAdmit({
    username: 'relay-user',
    password: PASSWORD,
    identity,
  });
  userStore.createNode({
    id: identity.nodeIdHex,
    userId: user.userId,
    name: 'self',
    version: NODE_VERSION,
    now: 1,
  });
  const wiring = createRelayWiring({
    db,
    identity: { nodeIdHex: identity.nodeIdHex, x25519PrivateKey: identity.x25519PrivateKey },
    userIdOf: () => user.userId,
  });
  // 与 mesh-runtime 的接线等价（`RelayWiring.notifyIfRelayRecord` → `RelaySecrets.reconcile`），
  // 只是把 promise 收起来让测试能等它落地。
  const pending: Array<Promise<unknown>> = [];
  keyLogService.onApplied = (_uid, step) => {
    const type = step.record.type;
    if (type === 'set-relays' || type === 'meta-key') pending.push(wiring.secrets.reconcile());
  };
  const publisher = opts?.publisher ?? livePublisher();
  const runtime = new MeshHttpRuntime({
    roles: opts?.roles ?? { hub: false, node: true, relay: false },
    nodeId: identity.nodeIdHex,
    nodePk: identity.edPublicKey,
    userStore,
    keyLogService,
    challengeStore: new ChallengeStore(),
    nodeSessionStore,
    publisher,
    primaryUserId: user.userId,
    hubStore: new MeshHubStore(db),
    attachedHub: opts?.attachedHub,
  });
  const { sid } = await challengeAndLogin(runtime, user, {
    target: identity.nodeIdHex,
    targetPk: identity.edPublicKey,
  });
  const settle = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  return {
    db,
    close,
    userStore,
    keyLogService,
    identity,
    user,
    runtime,
    publisher,
    wiring,
    sid,
    settle,
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** 用根钥签一条记录并按 `hub=sync` 提交，返回 HTTP 响应。 */
async function postRecord(
  b: Booted,
  input: {
    type: 'set-relays' | 'meta-key' | 'clear-totp' | 'revoke-node' | 'rotate-root-keep';
    payload: Uint8Array;
  }
): Promise<Response> {
  const state = b.keyLogService.currentState(b.user.userId);
  const record = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: b.user.userId,
    type: input.type,
    payload: input.payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(b.user.rootKey, bytes);
  const req = new Request('http://localhost/api/auth/keylog?hub=sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `tmex_s_self=${b.sid}` },
    body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }),
  });
  const res = await b.runtime.handleRequest(req, { upgrade: () => true });
  if (!(res instanceof Response)) throw new Error('unhandled keylog request');
  return res;
}

async function setRelaysPayload(
  b: Booted,
  opts: { url?: string; token: Uint8Array; epoch?: number; logKey?: Uint8Array }
): Promise<Uint8Array> {
  return buildSetRelaysPayload({
    relays: [{ url: opts.url ?? RELAY_URL, tenantId: TENANT_ID, token: opts.token, priority: 0 }],
    logKey: opts.logKey ?? generateTenantKey(),
    metaKey: generateTenantKey(),
    metaEpoch: opts.epoch ?? 1,
    nodes: listRelayNodeKeys(b.userStore, b.user.userId),
  });
}

/** 走完整条「接入中继」路径：签 set-relays → 落账 → 落库，之后本机就处于中继模式。 */
async function attachRelay(b: Booted, token = new Uint8Array(32).fill(9)): Promise<void> {
  const res = await postRecord(b, {
    type: 'set-relays',
    payload: await setRelaysPayload(b, { token }),
  });
  if (res.status !== 200) throw new Error(`attach failed: ${res.status}`);
  await b.settle();
}

function headSeq(b: Booted): bigint {
  return b.keyLogService.currentState(b.user.userId).head.seq;
}

async function successBody(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    seq: number;
    hubAck?: boolean;
    localApply?: boolean;
  };
}

describe('中继模式的密钥日志落账（hub=sync 本地优先）', () => {
  test('(a) 首次接入：没有任何上级时 set-relays 照样落账并切到中继模式', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      const before = headSeq(b);
      const token = new Uint8Array(32).fill(7);
      const res = await postRecord(b, {
        type: 'set-relays',
        payload: await setRelaysPayload(b, { token }),
      });
      expect(res.status).toBe(200);
      const body = await successBody(res);
      expect(body.ok).toBe(true);
      // 前端按 `hubAck === true` 判定「已确认」，中继模式下本地落账就是确认
      expect(body.hubAck).toBe(true);
      expect(body.localApply).toBe(true);
      expect(headSeq(b)).toBe(before + 1n);
      // 迁移中的记录绝不能回灌旧上级
      expect(b.publisher.acked).toHaveLength(0);
      expect(b.publisher.published).toHaveLength(0);

      await b.settle();
      expect(b.wiring.secrets.uplinkKind()).toBe('relay');
      expect(b.wiring.secrets.relayRows()).toEqual([
        { url: canonicalHubUrl(RELAY_URL), tenantId: TENANT_ID, priority: 0, kicked: false },
      ]);
      const stored = await b.wiring.secrets.store.getRelay(canonicalHubUrl(RELAY_URL));
      expect(stored?.token).toEqual(token);
    } finally {
      b.close();
    }
  });

  test('(b) 被踢后重新接入：链路已断也能把新令牌落账', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      const logKey = generateTenantKey();
      const oldToken = new Uint8Array(32).fill(1);
      expect(
        (
          await postRecord(b, {
            type: 'set-relays',
            payload: await setRelaysPayload(b, { token: oldToken, logKey }),
          })
        ).status
      ).toBe(200);
      await b.settle();
      expect(b.wiring.secrets.uplinkKind()).toBe('relay');
      b.wiring.secrets.store.markKicked(canonicalHubUrl(RELAY_URL), true);

      // 重新输入中继口令拿到新令牌 → 再签一条 set-relays
      const newToken = new Uint8Array(32).fill(2);
      const res = await postRecord(b, {
        type: 'set-relays',
        payload: await setRelaysPayload(b, { token: newToken, epoch: 2, logKey }),
      });
      expect(res.status).toBe(200);
      expect((await successBody(res)).hubAck).toBe(true);
      await b.settle();
      const stored = await b.wiring.secrets.store.getRelay(canonicalHubUrl(RELAY_URL));
      expect(stored?.token).toEqual(newToken);
      // replaceRelays 会把 kicked 归零，池子下一轮拨号即用新令牌
      expect(b.wiring.secrets.relayRows()[0]?.kicked).toBe(false);
    } finally {
      b.close();
    }
  });

  test('(c) hub → 中继迁移：set-relays 不发给旧 hub，也不受 attached-writer 判定阻挡', async () => {
    const attached: AttachedHub = {
      hubNodeId: 'cc'.repeat(16),
      publicUrl: 'https://hub.example',
      mode: 'active',
      writerEpoch: 1,
      since: 1,
    };
    const b = await boot({ publisher: livePublisher(), attachedHub: () => attached });
    try {
      const before = headSeq(b);
      const res = await postRecord(b, {
        type: 'set-relays',
        payload: await setRelaysPayload(b, { token: new Uint8Array(32).fill(3) }),
      });
      expect(res.status).toBe(200);
      expect(headSeq(b)).toBe(before + 1n);
      // 旧 hub 既没被要求确认，也没收到这条它可能不认识的记录
      expect(b.publisher.acked).toHaveLength(0);
      expect(b.publisher.published).toHaveLength(0);
      await b.settle();
      expect(b.wiring.secrets.uplinkKind()).toBe('relay');
    } finally {
      b.close();
    }
  });

  test('hub 模式下 attached 不是 writer 时，普通记录仍然 409 HUB_NOT_WRITER', async () => {
    const attached: AttachedHub = {
      hubNodeId: 'cc'.repeat(16),
      publicUrl: 'https://hub.example',
      mode: 'active',
      writerEpoch: 1,
      since: 1,
    };
    const b = await boot({ publisher: livePublisher(), attachedHub: () => attached });
    try {
      const res = await postRecord(b, { type: 'clear-totp', payload: encodeClearTotpPayload() });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('HUB_NOT_WRITER');
    } finally {
      b.close();
    }
  });

  test('中继模式下普通记录不再被 HUB_NOT_WRITER 挡住，并尽力推给中继', async () => {
    const attached: AttachedHub = {
      hubNodeId: null,
      publicUrl: RELAY_URL,
      mode: 'active',
      writerEpoch: 0,
      since: 1,
    };
    const b = await boot({ publisher: livePublisher(), attachedHub: () => attached });
    try {
      await attachRelay(b);
      const before = headSeq(b);
      const res = await postRecord(b, { type: 'clear-totp', payload: encodeClearTotpPayload() });
      expect(res.status).toBe(200);
      const body = await successBody(res);
      expect(body.hubAck).toBe(true);
      expect(body.localApply).toBe(true);
      expect(headSeq(b)).toBe(before + 1n);
      // 中继不做仲裁：不等 ack，直接尽力推
      expect(b.publisher.acked).toHaveLength(0);
      expect(b.publisher.published).toHaveLength(1);
    } finally {
      b.close();
    }
  });

  test('中继离线时普通记录照样落账（不再 504 / 409）', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      await attachRelay(b);
      const before = headSeq(b);
      const res = await postRecord(b, { type: 'clear-totp', payload: encodeClearTotpPayload() });
      expect(res.status).toBe(200);
      expect((await successBody(res)).hubAck).toBe(true);
      expect(headSeq(b)).toBe(before + 1n);
      // publish 抛了也不影响落账；记录由 RelayKeyLogSync 在重连后补推
      expect(b.publisher.published).toHaveLength(1);
      expect(b.publisher.acked).toHaveLength(0);
    } finally {
      b.close();
    }
  });

  test('meta-key 与 set-relays 一样本地优先：吊销后的轮换不依赖中继在线', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      expect(
        (
          await postRecord(b, {
            type: 'set-relays',
            payload: await setRelaysPayload(b, { token: new Uint8Array(32).fill(5) }),
          })
        ).status
      ).toBe(200);
      await b.settle();
      const before = headSeq(b);
      const res = await postRecord(b, {
        type: 'meta-key',
        payload: await buildMetaKeyPayload({
          metaKey: generateTenantKey(),
          epoch: 2,
          nodes: listRelayNodeKeys(b.userStore, b.user.userId),
        }),
      });
      expect(res.status).toBe(200);
      expect(headSeq(b)).toBe(before + 1n);
      await b.settle();
      expect(b.wiring.secrets.currentMetaEpoch()).toBe(2);
    } finally {
      b.close();
    }
  });

  test('追加第二条中继：新旧目标都落到 mesh_relays', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      const logKey = generateTenantKey();
      await postRecord(b, {
        type: 'set-relays',
        payload: await setRelaysPayload(b, { token: new Uint8Array(32).fill(6), logKey }),
      });
      await b.settle();
      const payload = await buildSetRelaysPayload({
        relays: [
          { url: RELAY_URL, tenantId: TENANT_ID, token: new Uint8Array(32).fill(6), priority: 0 },
          { url: RELAY_URL_2, tenantId: TENANT_ID, token: new Uint8Array(32).fill(8), priority: 1 },
        ],
        logKey,
        metaKey: generateTenantKey(),
        metaEpoch: 2,
        nodes: listRelayNodeKeys(b.userStore, b.user.userId),
      });
      expect((await postRecord(b, { type: 'set-relays', payload })).status).toBe(200);
      await b.settle();
      expect(b.wiring.secrets.relayRows().map((row) => row.url)).toEqual([
        canonicalHubUrl(RELAY_URL),
        canonicalHubUrl(RELAY_URL_2),
      ]);
    } finally {
      b.close();
    }
  });

  test('退出前的自吊销：中继模式下落账并带成员证明推给中继', async () => {
    const b = await boot({ publisher: livePublisher() });
    try {
      await attachRelay(b);
      const before = headSeq(b);
      const res = await postRecord(b, {
        type: 'revoke-node',
        payload: encodeRevokeNodePayload({
          node_id: hexToBytes(b.identity.nodeIdHex),
          reason: 'leave-hub',
        }),
      });
      expect(res.status).toBe(200);
      // 前端只有拿到 hubAck === true 才继续 POST /api/local/leave
      expect((await successBody(res)).hubAck).toBe(true);
      expect(headSeq(b)).toBe(before + 1n);
      // 推给中继的那一条就是这条吊销记录（RelayKeyLogSync 会给它挂 member 证明）
      expect(b.publisher.published).toHaveLength(1);
      expect(b.userStore.getCert(b.identity.nodeIdHex)?.revokedLogSeq).not.toBeNull();
    } finally {
      b.close();
    }
  });

  test('中继模式 rotate-root-keep：旧 peer 拦截，全员达标放行', async () => {
    const b = await boot({ publisher: offlinePublisher() });
    try {
      await attachRelay(b);
      const keepPayload = () =>
        encodeRotateRootKeepPayload({
          root_public_key: new Uint8Array(32).fill(4),
          kdf_params: generateKdfParams(),
          totp: null,
        });
      const token = new Uint8Array(32).fill(2);
      expect(
        (await postRecord(b, { type: 'set-relays', payload: await setRelaysPayload(b, { token }) }))
          .status
      ).toBe(200);
      await b.settle();

      b.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: b.user.userId,
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(8),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(8),
      });
      b.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'old',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: '1.1.15',
      });
      const oldPeer = await postRecord(b, { type: 'rotate-root-keep', payload: keepPayload() });
      expect(oldPeer.status).toBe(409);
      const oldBody = (await oldPeer.json()) as {
        code: string;
        minVersion: string;
        nodes: Array<{ id: string; name: string; version: string | null }>;
      };
      expect(oldBody.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(oldBody.minVersion).toBe(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION);
      expect(oldBody.nodes).toEqual([{ id: PEER_ID, name: 'old', version: '1.1.15' }]);

      b.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'ok',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 2,
        listVersion: 2,
        version: '1.1.16',
      });
      expect(
        (await postRecord(b, { type: 'rotate-root-keep', payload: keepPayload() })).status
      ).toBe(200);
    } finally {
      b.close();
    }
  });

  test('hub 模式的普通记录仍然先等 hub 确认（回归）', async () => {
    const b = await boot({ publisher: livePublisher() });
    try {
      const before = headSeq(b);
      const res = await postRecord(b, { type: 'clear-totp', payload: encodeClearTotpPayload() });
      expect(res.status).toBe(200);
      const body = await successBody(res);
      expect(body.hubAck).toBe(true);
      expect(body.localApply).toBeUndefined();
      expect(b.publisher.acked).toHaveLength(1);
      expect(headSeq(b)).toBe(before + 1n);
    } finally {
      b.close();
    }
  });
});
