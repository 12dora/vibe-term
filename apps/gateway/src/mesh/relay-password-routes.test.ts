import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { RELAY_TOKEN_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { generateTenantKey } from '@vibeterm/shared/relay';
import { nodeSessionCookieName } from '../auth/cookies';
import { KeyLogStore } from '../auth/key-log-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { SHARE_COOKIE_PREFIX } from '../share/share-token';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';
import { buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';
import { RelayRoutes } from './relay-routes';
import { RelaySecrets } from './relay-secrets';

const RELAY_URL = 'https://relay.example';
const TENANT_ID = 'ef'.repeat(16);

async function boot(
  fetchImpl?: typeof fetch,
  opts?: { standalone?: boolean; localAuthEffective?: boolean }
) {
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
    username: 'relay-password',
    password: 'relay-password-pass',
    identity,
  });
  const secrets = new RelaySecrets({
    db,
    identity: { nodeIdHex: identity.nodeIdHex, x25519PrivateKey: identity.x25519PrivateKey },
    userIdOf: () => user.userId,
  });
  const routes = new RelayRoutes({
    session: {
      roles: opts?.standalone ? { node: false, relay: false } : { node: true, relay: false },
      nodeSessionStore,
      ...(opts?.standalone ? { localAuthEffective: () => opts.localAuthEffective !== false } : {}),
    },
    nodeId: identity.nodeIdHex,
    userStore,
    keyLogService: service,
    secrets,
    uplink: {
      liveClient: () => null,
      attachedUplink: () => null,
      reconfigure: async () => {},
      candidates: () => [],
      switchTo: async () => ({ ok: true as const }),
    },
    ...(fetchImpl ? { fetchImpl } : {}),
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
  return { close, secrets, service, user, userStore, call, routes, cookie };
}

async function attach(b: Awaited<ReturnType<typeof boot>>) {
  const applied = await b.service.signAndApply(b.user.userId, b.user.rootKey, {
    type: 'set-relays',
    payload: await buildSetRelaysPayload({
      relays: [
        {
          url: RELAY_URL,
          tenantId: TENANT_ID,
          token: new Uint8Array(32).fill(6),
          priority: 0,
        },
      ],
      logKey: generateTenantKey(),
      metaKey: generateTenantKey(),
      metaEpoch: 1,
      nodes: listRelayNodeKeys(b.userStore, b.user.userId),
    }),
  });
  expect(applied.ok).toBe(true);
  await b.secrets.reconcile();
}

describe('GET/POST /api/mesh/relay/password', () => {
  test('GET returns known=false when the password was never stored', async () => {
    const b = await boot();
    try {
      await attach(b);
      const res = await b.call(`/api/mesh/relay/password?url=${encodeURIComponent(RELAY_URL)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ known: false, password: null, passwordEpoch: null });
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      b.close();
    }
  });

  test('GET reveals the stored plaintext', async () => {
    const b = await boot();
    try {
      await attach(b);
      await b.secrets.store.setEnrollPassword(RELAY_URL, 'hunter2x', 2);
      const res = await b.call(`/api/mesh/relay/password?url=${encodeURIComponent(RELAY_URL)}`);
      expect(await res.json()).toEqual({ known: true, password: 'hunter2x', passwordEpoch: 2 });
      const status = (await (await b.call('/api/mesh/relay/status')).json()) as {
        relays: Array<{ enrollPassword?: { known: boolean } }>;
      };
      expect(status.relays[0]?.enrollPassword).toEqual({ known: true });
    } finally {
      b.close();
    }
  });

  test('GET of an unattached url is 404 relay_not_attached', async () => {
    const b = await boot();
    try {
      const res = await b.call(
        `/api/mesh/relay/password?url=${encodeURIComponent('https://missing.example')}`
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'relay_not_attached' });
    } finally {
      b.close();
    }
  });

  test('POST forwards to rotate and stores next on success', async () => {
    const calls: Array<{ url: string; token: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        token: headers.get(RELAY_TOKEN_HEADER.name),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, passwordEpoch: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      await b.secrets.store.setEnrollPassword(RELAY_URL, 'old-password');
      const res = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL, next: 'new-password', mode: 'keep' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, passwordEpoch: 4 });
      expect(calls[0]?.url).toBe(`${RELAY_URL}/api/relay/password/rotate`);
      expect(calls[0]?.token).toBe(encodeBase64url(new Uint8Array(32).fill(6)));
      expect(calls[0]?.body).toEqual({
        tenantId: TENANT_ID,
        current: 'old-password',
        next: 'new-password',
        mode: 'keep',
      });
      expect(await b.secrets.store.getEnrollPassword(RELAY_URL)).toBe('new-password');
      expect(b.secrets.store.getEnrollPasswordEpoch(RELAY_URL)).toBe(4);
    } finally {
      b.close();
    }
  });

  test('POST maps relay_password_invalid / unreachable', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'relay_password_invalid' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      const invalid = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({
          url: RELAY_URL,
          current: 'wrong',
          next: 'new-password',
        }),
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toEqual({ code: 'relay_password_invalid' });
    } finally {
      b.close();
    }
  });

  test('POST using stored current that the relay rejects clears the local copy', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'relay_password_invalid' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      await b.secrets.store.setEnrollPassword(RELAY_URL, 'stale-password', 1);
      const res = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL, next: 'new-password' }),
      });
      expect(res.status).toBe(401);
      expect(b.secrets.store.hasEnrollPassword(RELAY_URL)).toBe(false);
      expect(await b.secrets.store.getEnrollPassword(RELAY_URL)).toBeNull();
      const view = await b.call(`/api/mesh/relay/password?url=${encodeURIComponent(RELAY_URL)}`);
      expect(await view.json()).toEqual({ known: false, password: null, passwordEpoch: null });
    } finally {
      b.close();
    }
  });

  test('POST maps RELAY_RATE_LIMITED to 429 with retryAfterMs', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'RELAY_RATE_LIMITED', retryAfterMs: 15_000 } }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '15' },
        }
      )) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      const res = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL, current: 'x', next: 'new-password' }),
      });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ code: 'RELAY_RATE_LIMITED', retryAfterMs: 15_000 });
    } finally {
      b.close();
    }
  });

  test('POST forwards relay_members_offline online/admitted', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'relay_members_offline', online: 1, admitted: 4 } }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      const res = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL, current: 'x', next: 'new-password', mode: 'kick' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: 'relay_members_offline',
        online: 1,
        admitted: 4,
      });
    } finally {
      b.close();
    }
  });

  test('POST network failure is 502 relay_unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const b = await boot(fetchImpl);
    try {
      await attach(b);
      const res = await b.call('/api/mesh/relay/password', {
        method: 'POST',
        body: JSON.stringify({ url: RELAY_URL, current: 'x', next: 'new-password' }),
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ code: 'relay_unreachable' });
    } finally {
      b.close();
    }
  });

  test('GET password auth boundary: no session / local bypass / remote / share / standalone', async () => {
    const b = await boot();
    const path = `/api/mesh/relay/password?url=${encodeURIComponent(RELAY_URL)}`;
    try {
      await attach(b);

      const noCookie = await b.routes.handle(
        new Request(`http://localhost${path}`),
        path.split('?')[0]!
      );
      expect(noCookie?.status).toBe(401);

      const local = new Request(`http://localhost${path}`);
      setMeshRequestContext(local, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      expect((await b.routes.handle(local, '/api/mesh/relay/password'))?.status).toBe(401);

      const remote = new Request(`http://localhost${path}`, {
        headers: { cookie: b.cookie },
      });
      setMeshRequestContext(remote, { via: 'ab'.repeat(16), clientIp: 'peer:entry' });
      expect((await b.routes.handle(remote, '/api/mesh/relay/password'))?.status).toBe(401);

      const share = new Request(`http://localhost${path}`, {
        headers: { cookie: `${SHARE_COOKIE_PREFIX}self=not-a-node-session` },
      });
      expect((await b.routes.handle(share, '/api/mesh/relay/password'))?.status).toBe(401);
    } finally {
      b.close();
    }

    const open = await boot(undefined, { standalone: true, localAuthEffective: false });
    try {
      const req = new Request(`http://localhost${path}`);
      expect((await open.routes.handle(req, '/api/mesh/relay/password'))?.status).toBe(401);
    } finally {
      open.close();
    }
  });
});
