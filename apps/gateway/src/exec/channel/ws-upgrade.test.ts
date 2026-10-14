import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryLocalAuthStore } from '../../db/local-auth-settings';
import { NODE_ID, bootMesh, challengeAndLogin } from '../../mesh/auth-routes.test';
import { liveSessionCount, resetExecRegistryForTests } from './registry';
import { makeEnv, openSession } from './test-harness';
import { EXEC_WS_KIND, type ExecWsData, handleExecWsUpgrade, isExecWsPath } from './ws-upgrade';

afterEach(() => resetExecRegistryForTests());

function upgradeSpy() {
  const calls: Array<{ data?: unknown }> = [];
  return {
    calls,
    server: {
      upgrade(_req: Request, opts?: { data?: unknown }) {
        calls.push({ data: opts?.data });
        return true;
      },
    },
  };
}

function wsRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers: { upgrade: 'websocket', ...headers } });
}

describe('isExecWsPath', () => {
  test('matches the plain, self and own-node-id forms only', () => {
    expect(isExecWsPath('/api/exec/ws')).toBe(true);
    expect(isExecWsPath('/n/self/api/exec/ws')).toBe(true);
    expect(isExecWsPath(`/n/${NODE_ID}/api/exec/ws`, NODE_ID)).toBe(true);
    expect(isExecWsPath(`/n/${NODE_ID}/api/exec/ws`)).toBe(false);
    expect(isExecWsPath('/n/other/api/exec/ws', NODE_ID)).toBe(false);
    expect(isExecWsPath('/api/exec')).toBe(false);
    expect(isExecWsPath('/ws')).toBe(false);
  });
});

describe('handleExecWsUpgrade', () => {
  test('non-upgrade request is 400 upgrade_required and never authenticates', async () => {
    const spy = upgradeSpy();
    let asked = false;
    const res = handleExecWsUpgrade(new Request('http://localhost/api/exec/ws'), spy.server, () => {
      asked = true;
      return { uid: null, tokenId: null };
    });
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({ code: 'upgrade_required' });
    expect(asked).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  test('a rejection from authenticate is returned untouched', () => {
    const spy = upgradeSpy();
    const denied = new Response(null, { status: 401 });
    expect(handleExecWsUpgrade(wsRequest('/api/exec/ws'), spy.server, () => denied)).toBe(denied);
    expect(spy.calls).toHaveLength(0);
  });

  test('a foreign browser origin is refused before authentication', async () => {
    const spy = upgradeSpy();
    const res = handleExecWsUpgrade(
      wsRequest('/api/exec/ws', { origin: 'http://evil.example' }),
      spy.server,
      () => ({ uid: 'u', tokenId: null })
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ code: 'FORBIDDEN_ORIGIN' });
    expect(spy.calls).toHaveLength(0);
  });

  test('same-host origin and missing origin pass', () => {
    const spy = upgradeSpy();
    const auth = () => ({ uid: 'u', tokenId: null });
    expect(
      handleExecWsUpgrade(
        wsRequest('/api/exec/ws', { origin: 'http://localhost' }),
        spy.server,
        auth
      )
    ).toBeUndefined();
    expect(handleExecWsUpgrade(wsRequest('/api/exec/ws'), spy.server, auth)).toBeUndefined();
    expect(spy.calls).toHaveLength(2);
  });

  test('upgrade failure is 500', async () => {
    const res = handleExecWsUpgrade(wsRequest('/api/exec/ws'), { upgrade: () => false }, () => ({
      uid: null,
      tokenId: null,
    }));
    expect(res?.status).toBe(500);
  });
});

describe('MeshHttpRuntime exec websocket guard', () => {
  test('node role: no session is plain HTTP 401 UNAUTHORIZED', async () => {
    const mesh = await bootMesh();
    try {
      const spy = upgradeSpy();
      const res = mesh.runtime.guardGatewayWebSocket(wsRequest('/api/exec/ws'), spy.server);
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ code: 'UNAUTHORIZED' });
      expect(spy.calls).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('node role: a valid session upgrades with its uid on every path form', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      for (const path of ['/api/exec/ws', '/n/self/api/exec/ws', `/n/${NODE_ID}/api/exec/ws`]) {
        const spy = upgradeSpy();
        const res = mesh.runtime.guardGatewayWebSocket(
          wsRequest(path, { cookie: `vibeterm_s_self=${sid}` }),
          spy.server
        );
        expect(res).toBeUndefined();
        expect(spy.calls[0]?.data).toEqual({
          kind: EXEC_WS_KIND,
          uid: mesh.boot.userId,
          tokenId: null,
          session: { sid, viaNodeId: 'self' },
        });
      }
    } finally {
      mesh.close();
    }
  });

  test('non-upgrade request to the exec path is 400 even when logged in', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/api/exec/ws', {
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }),
        upgradeSpy().server
      );
      expect(res?.status).toBe(400);
    } finally {
      mesh.close();
    }
  });

  test('a stale session cookie is 401', async () => {
    const mesh = await bootMesh();
    try {
      const res = mesh.runtime.guardGatewayWebSocket(
        wsRequest('/api/exec/ws', { cookie: 'vibeterm_s_self=stale' }),
        upgradeSpy().server
      );
      expect(res?.status).toBe(401);
    } finally {
      mesh.close();
    }
  });

  test('standalone without local auth upgrades as an unowned principal', async () => {
    const mesh = await bootMesh({ roles: { node: false, relay: false } });
    try {
      mesh.runtime.auth.setLocalAuthStore(new MemoryLocalAuthStore());
      const spy = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(wsRequest('/api/exec/ws'), spy.server)
      ).toBeUndefined();
      expect(spy.calls[0]?.data).toEqual({
        kind: EXEC_WS_KIND,
        uid: null,
        tokenId: null,
        session: null,
      });
    } finally {
      mesh.close();
    }
  });

  test('standalone with local auth: 401 without a session, upgrade with one', async () => {
    const mesh = await bootMesh({ roles: { node: false, relay: false } });
    try {
      const store = new MemoryLocalAuthStore();
      store.setEnabled(true);
      mesh.runtime.auth.setLocalAuthStore(store);

      const denied = upgradeSpy();
      const res = mesh.runtime.guardGatewayWebSocket(wsRequest('/api/exec/ws'), denied.server);
      expect(res?.status).toBe(401);
      expect(denied.calls).toHaveLength(0);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const allowed = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(
          wsRequest('/api/exec/ws', { cookie: `vibeterm_s_self=${sid}` }),
          allowed.server
        )
      ).toBeUndefined();
      expect(allowed.calls[0]?.data).toMatchObject({ kind: EXEC_WS_KIND, uid: mesh.boot.userId });
    } finally {
      mesh.close();
    }
  });

  test('other node prefixes are left to the forwarder', async () => {
    const mesh = await bootMesh();
    try {
      const spy = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(
          wsRequest(`/n/${'bb'.repeat(16)}/api/exec/ws`),
          spy.server
        )
      ).toBeNull();
    } finally {
      mesh.close();
    }
  });

  async function loggedInExecSession(mesh: Awaited<ReturnType<typeof bootMesh>>) {
    const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
    const spy = upgradeSpy();
    mesh.runtime.guardGatewayWebSocket(
      wsRequest('/api/exec/ws', { cookie: `vibeterm_s_self=${sid}` }),
      spy.server
    );
    const data = spy.calls[0]?.data as ExecWsData;
    const env = makeEnv();
    const bound = await openSession(
      env,
      {},
      { uid: data.uid, tokenId: null, session: data.session }
    );
    const unbound = await openSession(env, {}, { uid: data.uid, tokenId: null });
    return { sid, bound, unbound };
  }

  test('closeSocketsForSid terminates the exec session of that sid', async () => {
    const mesh = await bootMesh();
    try {
      const { sid, bound, unbound } = await loggedInExecSession(mesh);
      mesh.runtime.closeSocketsForSid('another-sid');
      expect(bound.proc.killCount).toBe(0);
      mesh.runtime.closeSocketsForSid(sid);
      expect(bound.proc.killCount).toBe(1);
      expect(bound.client.transport.closed?.code).toBe(4401);
      expect(unbound.proc.killCount).toBe(0);
    } finally {
      mesh.close();
    }
  });

  test('a session-revoking key log effect sweeps exec sessions', async () => {
    const mesh = await bootMesh();
    try {
      const { sid, bound, unbound } = await loggedInExecSession(mesh);
      mesh.runtime.applyKeyLogEffects(mesh.boot.userId, [{ type: 'revokeAllSessions' }]);
      expect(bound.proc.killCount).toBe(0);
      mesh.nodeSessionStore.revoke(sid);
      mesh.runtime.applyKeyLogEffects(mesh.boot.userId, [{ type: 'clearPeerCache' }]);
      expect(bound.proc.killCount).toBe(0);
      mesh.runtime.applyKeyLogEffects(mesh.boot.userId, [{ type: 'revokeAllSessions' }]);
      expect(bound.proc.killCount).toBe(1);
      expect(bound.client.transport.closed?.code).toBe(4401);
      expect(unbound.proc.killCount).toBe(0);
    } finally {
      mesh.close();
    }
  });

  test('logout (closeSocketsForUser) terminates that user exec sessions', async () => {
    const mesh = await bootMesh();
    try {
      const env = makeEnv();
      const mine = await openSession(env, {}, { uid: mesh.boot.userId, tokenId: null });
      const other = await openSession(env, {}, { uid: 'someone-else', tokenId: null });
      mesh.runtime.closeSocketsForUser(mesh.boot.userId);
      expect(mine.proc.killCount).toBe(1);
      expect(other.proc.killCount).toBe(0);
      expect(liveSessionCount()).toBe(1);
    } finally {
      mesh.close();
    }
  });
});
