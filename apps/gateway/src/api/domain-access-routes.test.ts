import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { ensureSiteSettingsInitialized, getStoredSiteSettings, updateSiteSettings } from '../db';
import { DomainAccessStore } from '../db/domain-access';
import { runMigrations } from '../db/migrate';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh/mesh-deps';
import { requestDispatchContext } from '../mesh/types';
import {
  DOMAIN_ACCESS_DISABLED,
  guardDomainAccess,
  listDomainAccessHosts,
  resetDomainAccessForTests,
  setDomainAccessGuardForTests,
  setDomainAccessStoreForTests,
} from './domain-access-routes';
import { handleApiRequest } from './index';
import { setSiteSettingsLinkProvider } from './site-settings-link';

const dbHandles: Array<{ close: () => void }> = [];

afterEach(() => {
  resetDomainAccessForTests();
  while (dbHandles.length > 0) dbHandles.pop()?.close();
});

function openIsolatedStore(): DomainAccessStore {
  const { db, close } = createMigratedAuthDb();
  dbHandles.push({ close });
  const store = new DomainAccessStore(db);
  setDomainAccessStoreForTests(store);
  return store;
}

describe('GET/PATCH /api/system/domain-access', () => {
  test('GET returns default allowed policy', async () => {
    openIsolatedStore();
    setDomainAccessGuardForTests({ hosts: ['tmex.example.com'] });
    const res = await handleApiRequest(
      new Request('https://tmex.example.com/api/system/domain-access')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: true,
      viaDomain: true,
      hosts: ['tmex.example.com'],
    });
  });

  test('PATCH updates allowed and returns the new view', async () => {
    const store = openIsolatedStore();
    setDomainAccessGuardForTests({ hosts: ['tmex.example.com'] });
    const res = await handleApiRequest(
      new Request('https://tmex.example.com/api/system/domain-access', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowed: false }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: false,
      viaDomain: true,
      hosts: ['tmex.example.com'],
    });
    expect(store.get().allowDomainAccess).toBe(false);
  });

  test('PATCH rejects a non-boolean allowed', async () => {
    openIsolatedStore();
    const res = await handleApiRequest(
      new Request('http://localhost/api/system/domain-access', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowed: 'no' }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_BODY');
  });

  test('dispatchHttp with via=<nodeId> (peer-inbound) can GET and PATCH', async () => {
    const store = openIsolatedStore();
    setDomainAccessGuardForTests({ hosts: ['tmex.example.com'] });
    const viaNodeId = 'ab'.repeat(16);
    async function dispatchHttp(
      request: Request,
      ctx: { uid: string | null; viaNodeId: string }
    ): Promise<Response> {
      requestDispatchContext.set(request, ctx);
      return handleApiRequest(request);
    }
    const getRes = await dispatchHttp(
      new Request('https://tmex.example.com/api/system/domain-access'),
      { uid: 'user-1', viaNodeId }
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      allowed: true,
      viaDomain: false,
      hosts: ['tmex.example.com'],
    });
    const patchRes = await dispatchHttp(
      new Request('https://tmex.example.com/api/system/domain-access', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowed: false }),
      }),
      { uid: 'user-1', viaNodeId }
    );
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toEqual({
      allowed: false,
      viaDomain: false,
      hosts: ['tmex.example.com'],
    });
    expect(store.get().allowDomainAccess).toBe(false);
  });

  test('viaDomain is true for via=self on a configured domain', async () => {
    openIsolatedStore();
    setDomainAccessGuardForTests({ hosts: ['tmex.example.com'] });
    const req = new Request('https://tmex.example.com/api/system/domain-access');
    setMeshRequestContext(req, { via: MESH_VIA_SELF });
    const res = await handleApiRequest(req);
    expect(res.status).toBe(200);
    expect((await res.json()) as { viaDomain: boolean }).toEqual(
      expect.objectContaining({ viaDomain: true })
    );
  });
});

describe('guardDomainAccess is not applied on the API route itself', () => {
  test('GET remains reachable so the hub UI can re-enable the policy', async () => {
    openIsolatedStore();
    setDomainAccessGuardForTests({ allowed: false, hosts: ['tmex.example.com'] });
    const res = await handleApiRequest(
      new Request('https://tmex.example.com/api/system/domain-access')
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
    expect(DOMAIN_ACCESS_DISABLED).toBe('DOMAIN_ACCESS_DISABLED');
  });
});

describe('guardDomainAccess enforces by client source, not Host', () => {
  function req(
    url: string,
    ctx: { clientIp?: string; trustProxy?: boolean; via?: string },
    headers?: Record<string, string>
  ): Request {
    const request = new Request(url, headers ? { headers } : undefined);
    setMeshRequestContext(request, {
      via: ctx.via ?? MESH_VIA_SELF,
      clientIp: ctx.clientIp,
      trustProxy: ctx.trustProxy,
    });
    return request;
  }

  afterEach(() => {
    resetDomainAccessForTests();
  });

  function disable(): void {
    setDomainAccessGuardForTests({ allowed: false, hosts: ['tmex.example.com'] });
  }

  test('public client + Host localhost or IP literal is 403', () => {
    disable();
    expect(guardDomainAccess(req('http://localhost/', { clientIp: '203.0.113.10' }))?.status).toBe(
      403
    );
    expect(
      guardDomainAccess(req('http://203.0.113.10/', { clientIp: '198.51.100.1' }))?.status
    ).toBe(403);
  });

  test('LAN client via the domain name and loopback are allowed', () => {
    disable();
    expect(
      guardDomainAccess(req('https://tmex.example.com/', { clientIp: '192.168.1.5' }))
    ).toBeNull();
    expect(
      guardDomainAccess(req('https://tmex.example.com/', { clientIp: '127.0.0.1' }))
    ).toBeNull();
    expect(
      guardDomainAccess(req('https://tmex.example.com/', { clientIp: '100.64.1.2' }))
    ).toBeNull();
  });

  test('unknown source is 403; service paths still pass from public', () => {
    disable();
    expect(guardDomainAccess(req('https://tmex.example.com/', {}))?.status).toBe(403);
    expect(
      guardDomainAccess(req('https://tmex.example.com/healthz', { clientIp: '203.0.113.10' }))
    ).toBeNull();
    expect(
      guardDomainAccess(req('https://tmex.example.com/n/abc/api/x', { clientIp: '203.0.113.10' }))
        ?.status
    ).toBe(403);
    expect(
      guardDomainAccess(req('https://tmex.example.com/ws', { clientIp: '203.0.113.10' }))?.status
    ).toBe(403);
  });

  test('TMEX_TRUST_PROXY=false with spoofed XFF is judged by socket address', () => {
    disable();
    expect(
      guardDomainAccess(
        req(
          'https://tmex.example.com/',
          { clientIp: '10.0.0.8', trustProxy: false },
          { 'x-forwarded-for': '203.0.113.9' }
        )
      )
    ).toBeNull();
    expect(
      guardDomainAccess(
        req(
          'https://tmex.example.com/',
          { clientIp: '203.0.113.9', trustProxy: false },
          { 'x-forwarded-for': '10.0.0.8' }
        )
      )?.status
    ).toBe(403);
  });

  test('TMEX_TRUST_PROXY=true uses XFF last segment', () => {
    disable();
    expect(
      guardDomainAccess(
        req(
          'https://tmex.example.com/',
          { clientIp: '10.0.0.8', trustProxy: true },
          { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }
        )
      )?.status
    ).toBe(403);
    expect(
      guardDomainAccess(
        req(
          'https://tmex.example.com/',
          { clientIp: '203.0.113.9', trustProxy: true },
          { 'x-forwarded-for': '1.2.3.4, 10.0.0.8' }
        )
      )
    ).toBeNull();
  });

  test('peer-inbound via=<nodeId> is not blocked', () => {
    disable();
    expect(
      guardDomainAccess(
        req('https://tmex.example.com/api/x', {
          via: 'ab'.repeat(16),
          clientIp: '203.0.113.10',
        })
      )
    ).toBeNull();
  });
});

describe('listDomainAccessHosts includes stored and projected site URL', () => {
  test('standalone save then mesh link lists both hosts', () => {
    runMigrations();
    ensureSiteSettingsInitialized();
    const prevUrl = getStoredSiteSettings().siteUrl;
    updateSiteSettings({ siteUrl: 'https://node-old.example' });
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'ab'.repeat(16),
      effectiveSiteUrl: () => 'https://hub.example',
    });
    try {
      const hosts = listDomainAccessHosts();
      expect(hosts).toContain('node-old.example');
      expect(hosts).toContain('hub.example');
    } finally {
      setSiteSettingsLinkProvider(null);
      updateSiteSettings({ siteUrl: prevUrl });
    }
  });
});
