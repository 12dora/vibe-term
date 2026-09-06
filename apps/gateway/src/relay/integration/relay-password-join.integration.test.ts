import { afterEach, describe, expect, test } from 'bun:test';
import {
  type RootKey,
  decodeBase64url,
  deriveSeed,
  encodeBase64url,
  encodeRotateRootKeepPayload,
  randomBytes,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { kdfParamsToWire, sealRelayPack, signRelayEnrollProof } from '@vibeterm/shared/relay';
import { and, eq, gt } from 'drizzle-orm';
import { createAuthContextFromDb } from '../../../../../packages/app/src/lib/local-auth';
import {
  RelayPasswordJoinError,
  performRelayPasswordJoin,
} from '../../../../../packages/app/src/lib/relay-password-join';
import { ensureNodeIdentity } from '../../auth';
import { MeshRelayStore } from '../../auth/mesh-relay-store';
import { NodeIdentityStore } from '../../auth/node-identity-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import { kdfParamsFromJson } from '../../auth/user-key-service';
import { UserStore } from '../../auth/user-store';
import { relayKeyLog } from '../../db/schema/relay';
import { RelaySecrets } from '../../mesh/relay-secrets';
import {
  NODE_PASSWORD,
  RELAY_TEST_PUBLIC_URL,
  type RelayMeshHarness,
  type RelayTenant,
  bootRelayMeshHarness,
  waitUntil,
  waitUntilAsync,
} from './relay-mesh-harness';

let harness: RelayMeshHarness | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot() {
  harness = await bootRelayMeshHarness({ password: 'relay-pass' });
  return harness;
}

async function uploadPack(
  h: RelayMeshHarness,
  tenant: RelayTenant,
  tokenOverride?: string
): Promise<void> {
  const material = await tenant.owner.json<{
    logKey: string;
    relays: Array<{ url: string; tenantId: string; token: string }>;
  }>('/api/mesh/relay/join-material');
  const primary = material.relays[0];
  const user = tenant.owner.userStore.getById(tenant.userId);
  if (!primary || !user || !material.logKey) throw new Error('join-material incomplete');
  const head = await tenant.owner.keys.head(tenant.userId);
  const sealed = await sealRelayPack({
    rootSeed: tenant.rootKey.seed,
    tenantId: primary.tenantId,
    rootPublicKey: user.rootPublicKey,
    rootEpoch: user.rootEpoch,
    plaintext: {
      log_key: decodeBase64url(material.logKey),
      token: decodeBase64url(tokenOverride ?? primary.token),
      head_seq: head.seq,
      head_hash: head.hash,
      issued_at: BigInt(Date.now()),
    },
  });
  const res = await h.relay.tenantFetch(
    `/api/relay/tenants/${primary.tenantId}/pack`,
    tokenOverride ?? primary.token,
    {
      method: 'POST',
      body: JSON.stringify({
        sealed_pack: encodeBase64url(sealed),
        kdf_params: kdfParamsToWire(kdfParamsFromJson(user.kdfParamsJson)),
        root_epoch: user.rootEpoch,
        head_seq: Number(head.seq),
      }),
    }
  );
  if (res.status !== 200) throw new Error(`pack upload ${res.status}: ${await res.text()}`);
}

async function waitOwnerCaughtUp(h: RelayMeshHarness, tenant: RelayTenant): Promise<void> {
  await waitUntilAsync(async () => {
    const local = await tenant.owner.keys.head(tenant.userId);
    const remote = h.relay.runtime.tenants.get(tenant.tenantId())?.keyLogHeadSeq ?? 0n;
    if (local.seq >= remote) return true;
    tenant.owner.relayClient()?.requestCatchUpNow();
    return false;
  }, 8_000);
}

const ROTATED_PASSWORD = 'relay-rotated-pass';

/** 本机 db 上的 RelaySecrets：等价于「网关启动时那一次 reconcile」。 */
async function localRelaySecrets(
  db: ReturnType<typeof createMigratedAuthDb>['db'],
  userId: string
): Promise<RelaySecrets> {
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  return new RelaySecrets({
    db,
    identity: {
      nodeIdHex: identity.nodeIdHex,
      x25519PrivateKey: identity.x25519PrivateKey,
    },
    userIdOf: () => userId,
  });
}

/** 主节点换发中继令牌并写下新的 `set-relays`：先弄丢本机那份令牌，enroll 才会走换发分支。 */
async function rotateTenantRelayToken(tenant: RelayTenant): Promise<void> {
  const row = tenant.owner.relayStore.listRelayRows()[0];
  if (!row) throw new Error('owner has no relay row');
  await tenant.owner.relayStore.setRelayToken({
    url: row.url,
    tenantId: row.tenantId,
    token: randomBytes(32),
    now: Date.now(),
  });
  await tenant.enroll({ password: 'relay-pass' });
}

/** 用新密码派生的根钥签一条 `rotate-root-keep`，并等中继跟上根公钥。 */
async function rotateTenantRootByPassword(
  h: RelayMeshHarness,
  tenant: RelayTenant,
  password: string
): Promise<RootKey> {
  const kdf = { salt: randomBytes(16), memory_kib: 19_456, iterations: 2, parallelism: 1 };
  const next = rootKeyFromSeed(await deriveSeed(password, kdf));
  const applied = await tenant.submitRecord(
    tenant.owner,
    'rotate-root-keep',
    encodeRotateRootKeepPayload({
      root_public_key: next.publicKey,
      kdf_params: kdf,
      totp: null,
    })
  );
  if (applied.status !== 200) {
    throw new Error(`rotate-root-keep ${applied.status}: ${await applied.text()}`);
  }
  tenant.rootKey = next;
  tenant.rootPublicKey = next.publicKey;
  tenant.rootEpoch += 1;
  const tenantId = tenant.tenantId();
  await waitUntil(
    () => h.relay.runtime.tenants.get(tenantId)?.rootEpoch === tenant.rootEpoch,
    8_000
  );
  return next;
}

/**
 * 直接打中继 `enroll` 换一份新令牌，但**不**发布任何 `set-relays`，密封包按新令牌重封。
 * 复刻「连着换发了两次、最新那条记录从未上链」这一形态。
 */
async function reissueTokenWithoutPublishing(
  h: RelayMeshHarness,
  tenant: RelayTenant
): Promise<Uint8Array> {
  const user = tenant.owner.userStore.getById(tenant.userId);
  if (!user) throw new Error('missing tenant user');
  const proof = signRelayEnrollProof(tenant.rootKey, {
    relayHost: new URL(RELAY_TEST_PUBLIC_URL).host,
    ts: Date.now(),
  });
  const res = await h.relay.fetch('/api/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: 'relay-pass',
      root_public_key: encodeBase64url(user.rootPublicKey),
      root_epoch: user.rootEpoch,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  if (res.status !== 200) throw new Error(`relay enroll ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string | null };
  if (!body.token) throw new Error('relay did not reissue a token');
  await uploadPack(h, tenant, body.token);
  return decodeBase64url(body.token);
}

/** 把发往中继密钥日志的 append 前 `times` 次改成 `SEQ_MISMATCH`，其余原样透传。 */
function seqMismatchFetcher(times: number): { fetcher: typeof fetch; appends: () => number } {
  const real = globalThis.fetch;
  let seen = 0;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (init?.body ? 'POST' : 'GET');
    if (href.includes('/keylog') && method === 'POST') {
      seen += 1;
      if (seen <= times) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'SEQ_MISMATCH', message: 'busy' } }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return { fetcher, appends: () => seen };
}

describe('relay password join', () => {
  test('A enrolls, uploads a pack, B joins by password, both share K_meta and see each other', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: () => {} });
    const joined = await performRelayPasswordJoin(
      {
        relayUrl: RELAY_TEST_PUBLIC_URL,
        tenantId: tenant.tenantId(),
        password: NODE_PASSWORD,
        name: 'alpha-b',
      },
      { auth }
    );
    const user = new UserStore(created.db).getById(joined.userId);
    if (!user) throw new Error('join did not persist a user');
    const seed = await deriveSeed(NODE_PASSWORD, kdfParamsFromJson(user.kdfParamsJson));
    const b = await h.bootNode('alpha-b', {
      userId: joined.userId,
      rootKey: rootKeyFromSeed(seed),
      db: created.db,
      close: created.close,
    });
    tenant.nodes.push(b);
    await waitUntil(() => b.mesh.uplink.state === 'online', 8_000);
    await waitOwnerCaughtUp(h, tenant);
    await waitUntil(() => b.metaEpochs().length > 0, 8_000);
    const shared = b.metaEpochs()[b.metaEpochs().length - 1];
    await waitUntil(() => tenant.owner.metaEpochs().includes(shared ?? -1), 8_000);
    await waitUntil(() => tenant.owner.userStore.getPeer(b.nodeId)?.name === 'alpha-b', 8_000);
    await waitUntil(() => b.userStore.getPeer(tenant.owner.nodeId)?.name === 'alpha-a', 8_000);
    expect(await b.relayStore.getSecret('meta', shared ?? 0)).toBeTruthy();
    expect(await tenant.owner.relayStore.getSecret('meta', shared ?? 0)).toBeTruthy();
  }, 30_000);

  test('keep 改密后密码加入的节点断线重连仍能认证', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: () => {} });
    const joined = await performRelayPasswordJoin(
      {
        relayUrl: RELAY_TEST_PUBLIC_URL,
        tenantId: tenant.tenantId(),
        password: NODE_PASSWORD,
        name: 'alpha-b',
      },
      { auth }
    );
    const user = new UserStore(created.db).getById(joined.userId);
    if (!user) throw new Error('join did not persist a user');
    const seed = await deriveSeed(NODE_PASSWORD, kdfParamsFromJson(user.kdfParamsJson));
    const b = await h.bootNode('alpha-b', {
      userId: joined.userId,
      rootKey: rootKeyFromSeed(seed),
      db: created.db,
      close: created.close,
    });
    tenant.nodes.push(b);
    await waitUntil(() => b.mesh.uplink.state === 'online', 8_000);

    const rotated = await h.relay.adminFetch('/api/relay/password', {
      method: 'POST',
      body: JSON.stringify({ password: 'second-pass', mode: 'keep' }),
    });
    expect(rotated.status).toBe(200);

    const tenantId = tenant.tenantId();
    h.relay.runtime.registry.get(tenantId, b.nodeId)?.link.close('test-drop');
    await waitUntil(() => h.relay.runtime.registry.get(tenantId, b.nodeId) == null, 8_000);
    await waitUntil(() => h.relay.runtime.registry.get(tenantId, b.nodeId) != null, 8_000);
    expect(b.relayStore.listRelayRows()[0]?.kicked).toBe(false);
  }, 30_000);

  test('同一账户重新取回令牌：追平缺失的 set-relays，reconcile 后仍是新令牌', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      const joined = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
          name: 'alpha-b',
        },
        { auth }
      );
      const store = new MeshRelayStore(created.db);
      const stale = (await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token;
      if (!stale) throw new Error('join stored no relay token');

      // 主节点换发令牌并写下新的 set-relays；本机此刻离线，拿不到这条记录
      await rotateTenantRelayToken(tenant);
      await uploadPack(h, tenant);
      const current = (await tenant.owner.relayStore.getRelay(RELAY_TEST_PUBLIC_URL))?.token;
      if (!current) throw new Error('owner lost its relay token');
      expect(current).not.toEqual(stale);
      store.markKicked(RELAY_TEST_PUBLIC_URL, true, 'password_rotated');

      const rekeyed = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
        },
        { auth }
      );
      expect(rekeyed.rekeyed).toBe(true);
      expect(rekeyed.userId).toBe(joined.userId);
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(current);
      expect(store.listRelayRows()[0]?.kicked).toBe(false);
      expect(new UserStore(created.db).listUsers()).toHaveLength(1);

      // 「下一次网关启动」：reconcile 按投影整表重写，不能再把令牌盖回旧的那份
      await (await localRelaySecrets(created.db, joined.userId)).reconcile();
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(current);
    } finally {
      created.close();
    }
  }, 30_000);

  test('连着换发两次、最新那条从未上链：以密封包里的令牌为准并补签', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      const joined = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
          name: 'alpha-b',
        },
        { auth }
      );
      const store = new MeshRelayStore(created.db);

      // 第一次换发写下了 set-relays（本机离线错过），第二次只换令牌、没上链
      await rotateTenantRelayToken(tenant);
      const published = (await tenant.owner.relayStore.getRelay(RELAY_TEST_PUBLIC_URL))?.token;
      const current = await reissueTokenWithoutPublishing(h, tenant);
      expect(current).not.toEqual(published ?? new Uint8Array());

      const rekeyed = await performRelayPasswordJoin(
        { relayUrl: RELAY_TEST_PUBLIC_URL, tenantId: tenant.tenantId(), password: NODE_PASSWORD },
        { auth }
      );
      // 「令牌和之前不一样」不等于「是当前那份」：必须落到密封包里的 current 上
      expect(rekeyed.rekeyed).toBe(true);
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(current);
      await (await localRelaySecrets(created.db, joined.userId)).reconcile();
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(current);
    } finally {
      created.close();
    }
  }, 30_000);

  test('补签遇到并发冲突：重下重签一次后成功，本机与中继不分叉', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      const joined = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
          name: 'alpha-b',
        },
        { auth }
      );
      const current = await reissueTokenWithoutPublishing(h, tenant);
      const gate = seqMismatchFetcher(1);

      const rekeyed = await performRelayPasswordJoin(
        { relayUrl: RELAY_TEST_PUBLIC_URL, tenantId: tenant.tenantId(), password: NODE_PASSWORD },
        { auth, fetcher: gate.fetcher }
      );
      expect(rekeyed.rekeyed).toBe(true);
      expect(gate.appends()).toBe(2);
      const store = new MeshRelayStore(created.db);
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(current);
      // 中继先落账、本机后落账：两侧的 head 必须一致，否则往后每次 rekey 都会被前缀校验拒掉
      const local = await auth.userKeys.head(joined.userId);
      expect(h.relay.runtime.tenants.get(tenant.tenantId())?.keyLogHeadSeq).toBe(local.seq);
    } finally {
      created.close();
    }
  }, 30_000);

  test('补签一直冲突：显式报错且本机 head 不动（不留分叉）', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      const joined = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
          name: 'alpha-b',
        },
        { auth }
      );
      await reissueTokenWithoutPublishing(h, tenant);
      const headBefore = await auth.userKeys.head(joined.userId);

      await expect(
        performRelayPasswordJoin(
          { relayUrl: RELAY_TEST_PUBLIC_URL, tenantId: tenant.tenantId(), password: NODE_PASSWORD },
          { auth, fetcher: seqMismatchFetcher(99).fetcher }
        )
      ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'join_failed' });
      const headAfter = await auth.userKeys.head(joined.userId);
      expect(headAfter.seq).toBe(headBefore.seq);
      expect(headAfter.hash).toEqual(headBefore.hash);
    } finally {
      created.close();
    }
  }, 30_000);

  test('漏掉一次根轮换的同账户成员仍能重新取回令牌', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);

    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      const joined = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: NODE_PASSWORD,
          name: 'alpha-b',
        },
        { auth }
      );
      const before = auth.userStore.getById(joined.userId)?.rootPublicKey;
      // 先上线一次让本机版本进 peer_cache（`rotate-root-keep` 有版本门），再断线
      const seed = await deriveSeed(
        NODE_PASSWORD,
        kdfParamsFromJson(new UserStore(created.db).getById(joined.userId)?.kdfParamsJson ?? '{}')
      );
      const b = await h.bootNode('alpha-b', {
        userId: joined.userId,
        rootKey: rootKeyFromSeed(seed),
        db: created.db,
        close: () => {},
      });
      await waitUntil(() => b.mesh.uplink.state === 'online', 8_000);
      await b.mesh.stop();

      // 主节点常规改密（rotate-root-keep）；本机离线错过了这条记录，本地根公钥就此落后
      const next = await rotateTenantRootByPassword(h, tenant, ROTATED_PASSWORD);
      await uploadPack(h, tenant);
      expect(auth.userStore.getById(joined.userId)?.rootPublicKey).toEqual(
        before ?? new Uint8Array()
      );

      const rekeyed = await performRelayPasswordJoin(
        {
          relayUrl: RELAY_TEST_PUBLIC_URL,
          tenantId: tenant.tenantId(),
          password: ROTATED_PASSWORD,
        },
        { auth }
      );
      expect(rekeyed.rekeyed).toBe(true);
      // 轮换记录被追平应用：本地根公钥跟上，令牌也换成了当前那份
      expect(auth.userStore.getById(joined.userId)?.rootPublicKey).toEqual(next.publicKey);
      const store = new MeshRelayStore(created.db);
      const owner = await tenant.owner.relayStore.getRelay(RELAY_TEST_PUBLIC_URL);
      expect((await store.getRelay(RELAY_TEST_PUBLIC_URL))?.token).toEqual(
        owner?.token ?? new Uint8Array()
      );
    } finally {
      created.close();
    }
  }, 30_000);

  test('a truncated key log is rejected against the sealed pack head', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);
    h.relay.db
      .delete(relayKeyLog)
      .where(and(eq(relayKeyLog.tenantId, tenant.tenantId()), gt(relayKeyLog.seq, 1)))
      .run();
    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      await expect(
        performRelayPasswordJoin(
          {
            relayUrl: RELAY_TEST_PUBLIC_URL,
            tenantId: tenant.tenantId(),
            password: NODE_PASSWORD,
          },
          { auth }
        )
      ).rejects.toMatchObject({
        name: 'RelayPasswordJoinError',
        code: 'relay_pack_invalid',
      });
    } finally {
      created.close();
    }
  }, 30_000);

  test('the wrong mesh password is rejected', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);
    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      await expect(
        performRelayPasswordJoin(
          {
            relayUrl: RELAY_TEST_PUBLIC_URL,
            tenantId: tenant.tenantId(),
            password: 'definitely-not-the-password',
          },
          { auth }
        )
      ).rejects.toBeInstanceOf(RelayPasswordJoinError);
    } finally {
      created.close();
    }
  }, 30_000);

  test('a pack from an old root_epoch is rejected after rotation', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);
    const oldEpoch = tenant.rootEpoch;
    const material = await tenant.owner.json<{
      relays: Array<{ token: string; tenantId: string }>;
    }>('/api/mesh/relay/join-material');
    const token = material.relays[0]?.token;
    if (!token) throw new Error('missing token');
    await tenant.rotateRoot();
    const kdf = await h.relay.fetch(`/api/relay/tenants/${tenant.tenantId()}/kdf`);
    expect(kdf.status).toBe(404);
    const stale = await h.relay.tenantFetch(`/api/relay/tenants/${tenant.tenantId()}/pack`, token, {
      method: 'POST',
      body: JSON.stringify({
        sealed_pack: encodeBase64url(new Uint8Array(48).fill(1)),
        kdf_params: {
          salt: encodeBase64url(new Uint8Array(16).fill(2)),
          memory_kib: 8,
          iterations: 1,
          parallelism: 1,
        },
        root_epoch: oldEpoch,
        head_seq: 0,
      }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_PACK_EPOCH_MISMATCH'
    );
  }, 30_000);

  test('a rejected admit append leaves no local user', async () => {
    const h = await boot();
    const tenant = await h.createTenant('alpha', { password: 'relay-pass' });
    await tenant.enroll();
    await uploadPack(h, tenant);
    const previous = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (init?.body ? 'POST' : 'GET');
      if (href.includes('/keylog') && method === 'POST') {
        posts += 1;
        if (posts === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'nope' } }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            })
          );
        }
      }
      return previous(input as RequestInfo, init);
    }) as typeof fetch;
    const created = createMigratedAuthDb();
    const auth = await createAuthContextFromDb(created.db, { close: created.close });
    try {
      await expect(
        performRelayPasswordJoin(
          {
            relayUrl: RELAY_TEST_PUBLIC_URL,
            tenantId: tenant.tenantId(),
            password: NODE_PASSWORD,
          },
          { auth }
        )
      ).rejects.toBeInstanceOf(RelayPasswordJoinError);
      expect(auth.userStore.listUsers()).toHaveLength(0);
    } finally {
      globalThis.fetch = previous;
      created.close();
    }
  }, 30_000);
});
