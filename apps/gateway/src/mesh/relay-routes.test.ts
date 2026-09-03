import { describe, expect, test } from 'bun:test';
import {
  bytesToHex,
  canonicalHubUrl,
  decodeBase64url,
  decodeMetaKeyPayload,
  decodeSetRelaysPayload,
  encodeBase64url,
  hubHostFromUrl,
  wrapEntryFromBytes,
} from '@tmex/shared/auth';
import { generateTenantKey, signRelayEnrollProof, unwrapKeyForNode } from '@tmex/shared/relay';
import { nodeSessionCookieName } from '../auth/cookies';
import { KeyLogStore } from '../auth/key-log-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { MESH_VIA_SELF } from './mesh-deps';
import { buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';
import { RelayRoutes } from './relay-routes';
import { RelaySecrets } from './relay-secrets';

const RELAY_URL = 'https://relay.example';
const RELAY_URL_2 = 'https://relay-2.example';
const RELAY_URL_3 = 'https://relay-3.example';
const TENANT_ID = 'ef'.repeat(16);

async function boot(opts: { fetchImpl?: typeof fetch } = {}) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const service = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore,
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await service.bootstrapUserWithSelfAdmit({
    username: 'relay-routes',
    password: 'relay-routes-pass',
    identity,
  });
  const secrets = new RelaySecrets({
    db,
    identity: { nodeIdHex: identity.nodeIdHex, x25519PrivateKey: identity.x25519PrivateKey },
    userIdOf: () => user.userId,
  });
  const routes = new RelayRoutes({
    session: {
      roles: { hub: false, node: true, relay: false },
      nodeSessionStore,
    },
    nodeId: identity.nodeIdHex,
    userStore,
    keyLogService: service,
    secrets,
    uplink: {
      liveClient: () => null,
      attachedHub: () => null,
      reconfigure: async () => {},
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const session = nodeSessionStore.issue({
    userId: user.userId,
    viaNodeId: MESH_VIA_SELF,
    sessPublicKey: new Uint8Array(32).fill(1),
    delegationMethod: 'root',
    now: Date.now(),
  });
  const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${session.sid}`;
  const call = async (path: string, init?: RequestInit) => {
    const req = new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), cookie },
    });
    const res = await routes.handle(req, new URL(req.url).pathname);
    if (!res) throw new Error(`no route for ${path}`);
    return res;
  };
  return { db, close, userStore, service, identity, user, secrets, routes, call };
}

async function configureRelays(b: Awaited<ReturnType<typeof boot>>, urls: string[]) {
  const logKey = generateTenantKey();
  const metaKey = generateTenantKey();
  const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
    type: 'set-relays',
    payload: await buildSetRelaysPayload({
      relays: urls.map((url, index) => ({
        url,
        tenantId: TENANT_ID,
        token: new Uint8Array(32).fill(6),
        priority: index,
      })),
      logKey,
      metaKey,
      metaEpoch: 1,
      nodes: listRelayNodeKeys(b.userStore, b.user.userId),
    }),
  });
  expect(applied.ok).toBe(true);
  await b.secrets.reconcile();
  return { logKey, metaKey };
}

async function configureRelay(b: Awaited<ReturnType<typeof boot>>) {
  return configureRelays(b, [RELAY_URL]);
}

describe('RelayRoutes', () => {
  test('status 在 hub 模式也回答，接入后变 relay', async () => {
    const b = await boot();
    try {
      const before = (await (await b.call('/api/mesh/relay/status')).json()) as {
        mode: string;
        relays: unknown[];
      };
      expect(before.mode).toBe('hub');
      expect(before.relays).toEqual([]);

      await configureRelay(b);
      const after = (await (await b.call('/api/mesh/relay/status')).json()) as {
        mode: string;
        tenantId: string;
        metaEpoch: number;
        relays: Array<{ url: string; priority: number; kicked: boolean }>;
        reauthRequired: boolean;
      };
      expect(after.mode).toBe('relay');
      expect(after.tenantId).toBe(TENANT_ID);
      expect(after.metaEpoch).toBe(1);
      expect(after.relays).toEqual([
        {
          url: canonicalHubUrl(RELAY_URL),
          priority: 0,
          online: false,
          attached: false,
          rttMs: null,
          lastError: null,
          kicked: false,
        },
      ] as never);
      expect(after.reauthRequired).toBe(false);
    } finally {
      b.close();
    }
  });

  test('未登录返回 401', async () => {
    const b = await boot();
    try {
      const req = new Request('http://localhost/api/mesh/relay/status');
      const res = await b.routes.handle(req, '/api/mesh/relay/status');
      expect(res).not.toBeNull();
      expect((await res!).status).toBe(401);
    } finally {
      b.close();
    }
  });

  test('proof-material + enroll 产出可解码的 set-relays payload', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          tenant_id: TENANT_ID,
          token: encodeBase64url(new Uint8Array(32).fill(8)),
          password_epoch: 3,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    const b = await boot({ fetchImpl });
    try {
      const material = (await (
        await b.call('/api/mesh/relay/enroll/proof-material', {
          method: 'POST',
          body: JSON.stringify({ url: RELAY_URL }),
        })
      ).json()) as { relayHost: string; ts: number; rootPublicKey: string };
      expect(material.relayHost).toBe(hubHostFromUrl(RELAY_URL));
      expect(decodeBase64url(material.rootPublicKey)).toEqual(b.user.rootPublicKey);

      const proof = signRelayEnrollProof(b.user.rootKey, {
        relayHost: material.relayHost,
        ts: material.ts,
      });
      const res = await b.call('/api/mesh/relay/enroll', {
        method: 'POST',
        body: JSON.stringify({
          url: RELAY_URL,
          password: 'hunter2',
          proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tenantId: string;
        token: string;
        passwordEpoch: number;
        payload: string;
        payloadHash: string;
        metaEpoch: number;
      };
      expect(body.tenantId).toBe(TENANT_ID);
      expect(body.passwordEpoch).toBe(3);
      expect(calls[0]?.url).toBe(`${RELAY_URL}/api/relay/enroll`);
      expect(calls[0]?.body.password).toBe('hunter2');
      expect(calls[0]?.body.proof).toEqual({
        bytes: encodeBase64url(proof.bytes),
        sig: encodeBase64url(proof.sig),
      });
      expect(calls[0]?.body.root_public_key).toBe(encodeBase64url(b.user.rootPublicKey));

      const payload = decodeSetRelaysPayload(decodeBase64url(body.payload));
      expect(payload.mode).toBe('ordered');
      expect(payload.relays).toHaveLength(1);
      expect(bytesToHex(payload.relays[0]?.tenant_id ?? new Uint8Array())).toBe(TENANT_ID);
      expect(payload.relays[0]?.url).toBe(canonicalHubUrl(RELAY_URL));
      expect(payload.log_key).toHaveLength(1);
      expect(payload.meta_key.epoch).toBe(1);

      // 本节点能用自己的 x25519 私钥解出封装的密钥
      const entry = wrapEntryFromBytes(payload.meta_key.entries[0]!);
      const metaKey = await unwrapKeyForNode({
        entry,
        nodeX25519Sk: b.identity.x25519PrivateKey,
      });
      expect(metaKey.byteLength).toBe(32);

      // 签名落账后 reconcile 能拿到同一把 K_meta
      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: decodeBase64url(body.payload),
      });
      expect(applied.ok).toBe(true);
      const result = await b.secrets.reconcile();
      expect(result.kind).toBe('relay');
      expect(await b.secrets.metaKey(1)).toEqual(metaKey);
    } finally {
      b.close();
    }
  });

  test('enroll 拒绝伪造的根签名 proof', async () => {
    const b = await boot({
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    try {
      const res = await b.call('/api/mesh/relay/enroll', {
        method: 'POST',
        body: JSON.stringify({
          url: RELAY_URL,
          proof: {
            bytes: encodeBase64url(new Uint8Array(16).fill(1)),
            sig: encodeBase64url(new Uint8Array(64)),
          },
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { code: string }).toMatchObject({ code: 'BAD_PROOF' });
    } finally {
      b.close();
    }
  });

  test('leave/prepare 产出空 relays 的 set-relays', async () => {
    const b = await boot();
    try {
      await configureRelay(b);
      const body = (await (
        await b.call('/api/mesh/relay/leave/prepare', { method: 'POST' })
      ).json()) as { payload: string; metaEpoch: number };
      const payload = decodeSetRelaysPayload(decodeBase64url(body.payload));
      expect(payload.relays).toEqual([]);
      expect(payload.log_key).toEqual([]);
      expect(body.metaEpoch).toBe(1);

      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: decodeBase64url(body.payload),
      });
      expect(applied.ok).toBe(true);
      expect((await b.secrets.reconcile()).kind).toBe('hub');
    } finally {
      b.close();
    }
  });

  test('remove/prepare 摘掉一条中继并把优先级重排成 0..n-1', async () => {
    const b = await boot();
    try {
      const { metaKey } = await configureRelays(b, [RELAY_URL, RELAY_URL_2, RELAY_URL_3]);
      const res = await b.call('/api/mesh/relay/remove/prepare', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL_2 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payload: string; metaEpoch: number };
      // 世代不变：剩下的中继继续用同一把 K_meta，摘一条不是轮换。
      expect(body.metaEpoch).toBe(1);
      const payload = decodeSetRelaysPayload(decodeBase64url(body.payload));
      expect(payload.relays.map((relay) => relay.url)).toEqual([
        canonicalHubUrl(RELAY_URL),
        canonicalHubUrl(RELAY_URL_3),
      ]);
      expect(payload.relays.map((relay) => relay.priority)).toEqual([0, 1]);
      expect(payload.meta_key.epoch).toBe(1);
      expect(payload.log_key).toHaveLength(1);
      const unwrapped = await unwrapKeyForNode({
        entry: wrapEntryFromBytes(payload.meta_key.entries[0]!),
        nodeX25519Sk: b.identity.x25519PrivateKey,
      });
      expect(unwrapped).toEqual(metaKey);

      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'set-relays',
        payload: decodeBase64url(body.payload),
      });
      expect(applied.ok).toBe(true);
      await b.secrets.reconcile();
      expect(b.secrets.relayRows().map((row) => row.url)).toEqual([
        canonicalHubUrl(RELAY_URL),
        canonicalHubUrl(RELAY_URL_3),
      ]);
    } finally {
      b.close();
    }
  });

  test('remove/prepare 不认的地址 404，最后一条 409，hub 模式 409', async () => {
    const b = await boot();
    try {
      const hubMode = await b.call('/api/mesh/relay/remove/prepare', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL }),
      });
      expect(hubMode.status).toBe(409);
      expect((await hubMode.json()) as { code: string }).toMatchObject({
        code: 'RELAY_NOT_CONFIGURED',
      });

      await configureRelay(b);
      const last = await b.call('/api/mesh/relay/remove/prepare', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL }),
      });
      expect(last.status).toBe(409);
      expect((await last.json()) as { code: string }).toMatchObject({ code: 'RELAY_LAST' });

      await configureRelays(b, [RELAY_URL, RELAY_URL_2]);
      const missing = await b.call('/api/mesh/relay/remove/prepare', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL_3 }),
      });
      expect(missing.status).toBe(404);
      expect((await missing.json()) as { code: string }).toMatchObject({
        code: 'RELAY_NOT_FOUND',
      });

      const bad = await b.call('/api/mesh/relay/remove/prepare', {
        method: 'POST',
        body: JSON.stringify({ url: 'not a url' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      b.close();
    }
  });

  test('enroll 透传中继 { error: { code } } 形状里的错误码', async () => {
    const b = await boot({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { code: 'RELAY_PASSWORD_INVALID', message: 'nope' } }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch,
    });
    try {
      const material = (await (
        await b.call('/api/mesh/relay/enroll/proof-material', {
          method: 'POST',
          body: JSON.stringify({ url: RELAY_URL }),
        })
      ).json()) as { relayHost: string; ts: number };
      const proof = signRelayEnrollProof(b.user.rootKey, {
        relayHost: material.relayHost,
        ts: material.ts,
      });
      const res = await b.call('/api/mesh/relay/enroll', {
        method: 'POST',
        body: JSON.stringify({
          url: RELAY_URL,
          password: 'wrong',
          proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
        }),
      });
      expect(res.status).toBe(401);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'RELAY_PASSWORD_INVALID',
      });
    } finally {
      b.close();
    }
  });

  test('meta-key/prepare admit 复用当前密钥换新世代，rotate 换新密钥', async () => {
    const b = await boot();
    try {
      const { metaKey } = await configureRelay(b);
      const admit = (await (
        await b.call('/api/mesh/relay/meta-key/prepare', {
          method: 'POST',
          body: JSON.stringify({ op: 'admit', node_id: b.identity.nodeIdHex }),
        })
      ).json()) as { epoch: number; payload: string };
      expect(admit.epoch).toBe(2);
      const admitPayload = decodeMetaKeyPayload(decodeBase64url(admit.payload));
      expect(admitPayload.epoch).toBe(2);
      const admitKey = await unwrapKeyForNode({
        entry: wrapEntryFromBytes(admitPayload.entries[0]!),
        nodeX25519Sk: b.identity.x25519PrivateKey,
      });
      expect(admitKey).toEqual(metaKey);

      const rotate = (await (
        await b.call('/api/mesh/relay/meta-key/prepare', {
          method: 'POST',
          body: JSON.stringify({ op: 'rotate' }),
        })
      ).json()) as { epoch: number; payload: string };
      const rotatePayload = decodeMetaKeyPayload(decodeBase64url(rotate.payload));
      const rotateKey = await unwrapKeyForNode({
        entry: wrapEntryFromBytes(rotatePayload.entries[0]!),
        nodeX25519Sk: b.identity.x25519PrivateKey,
      });
      expect(rotateKey).not.toEqual(metaKey);

      const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
        type: 'meta-key',
        payload: decodeBase64url(rotate.payload),
      });
      expect(applied.ok).toBe(true);
      const result = await b.secrets.reconcile();
      expect(result.metaEpoch).toBe(2);
      expect(await b.secrets.metaKey(2)).toEqual(rotateKey);
    } finally {
      b.close();
    }
  });

  test('meta-key/prepare 对未知节点报 404，hub 模式报 409', async () => {
    const b = await boot();
    try {
      const hubMode = await b.call('/api/mesh/relay/meta-key/prepare', {
        method: 'POST',
        body: JSON.stringify({ op: 'rotate' }),
      });
      expect(hubMode.status).toBe(409);
      expect((await hubMode.json()) as { code: string }).toMatchObject({
        code: 'RELAY_NOT_CONFIGURED',
      });

      await configureRelay(b);
      const unknown = await b.call('/api/mesh/relay/meta-key/prepare', {
        method: 'POST',
        body: JSON.stringify({ op: 'admit', node_id: '00'.repeat(16) }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      b.close();
    }
  });

  test('join-material 只在中继模式返回租户密钥', async () => {
    const b = await boot();
    try {
      expect((await b.call('/api/mesh/relay/join-material')).status).toBe(409);
      const { logKey } = await configureRelay(b);
      const body = (await (await b.call('/api/mesh/relay/join-material')).json()) as {
        tenantId: string;
        token: string;
        logKey: string;
        relays: Array<{ url: string; tenantId: string; token: string }>;
      };
      expect(body.tenantId).toBe(TENANT_ID);
      expect(decodeBase64url(body.token)).toEqual(new Uint8Array(32).fill(6));
      expect(decodeBase64url(body.logKey)).toEqual(logKey);
      // 只带持有 enrollment 的那台中继，且带上它自己的租户凭据。
      expect(body.relays).toHaveLength(1);
      expect(body.relays[0].url).toBe(canonicalHubUrl(RELAY_URL));
      expect(body.relays[0].tenantId).toBe(TENANT_ID);
      expect(decodeBase64url(body.relays[0].token)).toEqual(new Uint8Array(32).fill(6));
    } finally {
      b.close();
    }
  });

  test('enrollments 在离线时 503', async () => {
    const b = await boot();
    try {
      await configureRelay(b);
      const res = await b.call('/api/mesh/relay/enrollments', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
    } finally {
      b.close();
    }
  });
});
