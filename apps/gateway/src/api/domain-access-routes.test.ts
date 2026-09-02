import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { DomainAccessStore } from '../db/domain-access';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh/mesh-deps';
import { requestDispatchContext } from '../mesh/types';
import {
  DOMAIN_ACCESS_DISABLED,
  resetDomainAccessForTests,
  setDomainAccessGuardForTests,
  setDomainAccessStoreForTests,
} from './domain-access-routes';
import { handleApiRequest } from './index';

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
