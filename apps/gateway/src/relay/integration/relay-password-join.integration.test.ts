import { afterEach, describe, expect, test } from 'bun:test';
import { decodeBase64url, deriveSeed, encodeBase64url, rootKeyFromSeed } from '@tmex/shared/auth';
import { kdfParamsToWire, sealRelayPack } from '@tmex/shared/relay';
import { and, eq, gt } from 'drizzle-orm';
import { createAuthContextFromDb } from '../../../../../packages/app/src/lib/local-auth';
import {
  RelayPasswordJoinError,
  performRelayPasswordJoin,
} from '../../../../../packages/app/src/lib/relay-password-join';
import { createMigratedAuthDb } from '../../auth/test-db';
import { kdfParamsFromJson } from '../../auth/user-key-service';
import { UserStore } from '../../auth/user-store';
import { relayKeyLog } from '../../db/schema/relay';
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

async function uploadPack(h: RelayMeshHarness, tenant: RelayTenant): Promise<void> {
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
      token: decodeBase64url(primary.token),
      head_seq: head.seq,
      head_hash: head.hash,
      issued_at: BigInt(Date.now()),
    },
  });
  const res = await h.relay.tenantFetch(
    `/api/relay/tenants/${primary.tenantId}/pack`,
    primary.token,
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
        code: 'head_hash_mismatch',
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
