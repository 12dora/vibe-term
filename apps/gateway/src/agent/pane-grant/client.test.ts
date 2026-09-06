import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createAgentSession, getAgentSessionById, updateAgentSession } from '../../db/agent';
import { runMigrations } from '../../db/migrate';
import { type MeshAgentBridge, setMeshAgentBridge } from '../../mesh/mesh-agent-bridge';
import {
  ensureSessionGrant,
  loadSessionGrant,
  markSessionGrantStale,
  mintPaneGrant,
  resetPaneGrantClientForTests,
  sessionPaneGrantSource,
} from './client';
import { PANE_GRANT_ROUTE } from './routes';

const NODE_X = 'a'.repeat(32);
const NODE_Y = 'b'.repeat(32);

interface Forwarded {
  nodeId: string;
  method: string;
  path: string;
  body?: unknown;
}

function stubBridge(
  respond: (input: Forwarded) => Response,
  calls: Forwarded[] = []
): { bridge: MeshAgentBridge; calls: Forwarded[] } {
  const bridge: MeshAgentBridge = {
    selfNodeId: NODE_X,
    lookupNode: () => 'online',
    forwardInternalHttp: async () => new Response('{}', { status: 200 }),
    forwardAuthorizedHttp: async (_req, input) => {
      calls.push(input);
      return respond(input);
    },
  };
  setMeshAgentBridge(bridge);
  return { bridge, calls };
}

function grantResponse(grantId = 'g1', token = 't1'): Response {
  return new Response(JSON.stringify({ grantId, token, expiresAt: Date.now() + 86_400_000 }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

const browserReq = () => new Request('http://localhost/api/agent/sessions', { method: 'POST' });

function newRemoteSession(paneId = '%1') {
  return createAgentSession({
    title: 'grant-client',
    nodeId: NODE_Y,
    deviceId: 'remote-device',
    paneId,
    modelId: 'm',
  });
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  resetPaneGrantClientForTests();
});

afterEach(() => {
  setMeshAgentBridge(null);
});

describe('mintPaneGrant', () => {
  test('成功：按目标节点签发，请求体带本机 node id', async () => {
    const { calls } = stubBridge(() => grantResponse('g-ok', 't-ok'));
    const result = await mintPaneGrant(browserReq(), {
      nodeId: NODE_Y,
      deviceId: 'dev',
      paneId: '%1',
    });
    expect(result).toMatchObject({ kind: 'ok', grant: { grantId: 'g-ok', token: 't-ok' } });
    expect(calls[0]).toMatchObject({ nodeId: NODE_Y, method: 'POST', path: PANE_GRANT_ROUTE });
    expect(calls[0]?.body).toMatchObject({ fromNodeId: NODE_X, deviceId: 'dev', paneId: '%1' });
  });

  test('目标节点没有该路由（旧版本）→ unsupported，且短期内不再重复探测', async () => {
    const { calls } = stubBridge(
      () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    );
    expect(
      await mintPaneGrant(browserReq(), { nodeId: NODE_Y, deviceId: 'd', paneId: '%1' })
    ).toEqual({ kind: 'unsupported' });
    expect(
      await mintPaneGrant(browserReq(), { nodeId: NODE_Y, deviceId: 'd', paneId: '%1' })
    ).toEqual({ kind: 'unsupported' });
    expect(calls).toHaveLength(1);
  });

  test('设备不存在的 404 不当成旧版本', async () => {
    stubBridge(() => new Response(JSON.stringify({ error: 'device_not_found' }), { status: 404 }));
    expect(
      await mintPaneGrant(browserReq(), { nodeId: NODE_Y, deviceId: 'ghost', paneId: '%1' })
    ).toEqual({ kind: 'failed', status: 404 });
  });

  test('浏览器没有目标节点会话 → login-required 原样透出 401', async () => {
    stubBridge(
      () =>
        new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_Y }), {
          status: 401,
        })
    );
    const result = await mintPaneGrant(browserReq(), {
      nodeId: NODE_Y,
      deviceId: 'd',
      paneId: '%1',
    });
    expect(result.kind).toBe('login-required');
    if (result.kind !== 'login-required') throw new Error('unreachable');
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ code: 'NODE_LOGIN_REQUIRED' });
  });
});

describe('ensureSessionGrant', () => {
  test('本机窗格会话不签授权，也不打目标节点', async () => {
    const { calls } = stubBridge(() => grantResponse());
    const session = createAgentSession({
      title: 'local',
      deviceId: 'local-device',
      paneId: '%1',
      modelId: 'm',
    });
    expect(await ensureSessionGrant(browserReq(), session)).toEqual({ ok: true, grant: null });
    expect(calls).toHaveLength(0);
  });

  test('远端会话缺授权 → 补签并加密落库；已有有效授权则不再签', async () => {
    const { calls } = stubBridge(() => grantResponse('g-persist', 't-persist'));
    const session = newRemoteSession();

    const first = await ensureSessionGrant(browserReq(), session);
    expect(first).toMatchObject({ ok: true, grant: { grantId: 'g-persist' } });
    const stored = getAgentSessionById(session.id)?.remoteGrant ?? '';
    expect(stored).not.toBe('');
    expect(stored).not.toContain('t-persist');
    expect(await loadSessionGrant(session.id)).toMatchObject({
      grantId: 'g-persist',
      token: 't-persist',
      paneId: '%1',
    });

    const reloaded = getAgentSessionById(session.id);
    if (!reloaded) throw new Error('session missing');
    await ensureSessionGrant(browserReq(), reloaded);
    expect(calls).toHaveLength(1);
  });

  test('被目标节点拒收后标记 → 下一次请求重签', async () => {
    let issued = 0;
    stubBridge(() => {
      issued += 1;
      return grantResponse(`g-${issued}`, 't');
    });
    const session = newRemoteSession('%2');
    await ensureSessionGrant(browserReq(), session);

    markSessionGrantStale(session.id);
    const again = getAgentSessionById(session.id);
    if (!again) throw new Error('session missing');
    expect(await ensureSessionGrant(browserReq(), again)).toMatchObject({
      ok: true,
      grant: { grantId: 'g-2' },
    });
  });

  test('改绑窗格后旧授权不匹配 → 重签', async () => {
    let issued = 0;
    stubBridge(() => {
      issued += 1;
      return grantResponse(`r-${issued}`, 't');
    });
    const session = newRemoteSession('%3');
    await ensureSessionGrant(browserReq(), session);

    const rebound = updateAgentSession(session.id, { paneId: '%4' });
    if (!rebound) throw new Error('session missing');
    const ensured = await ensureSessionGrant(browserReq(), rebound);
    expect(ensured).toMatchObject({ ok: true, grant: { grantId: 'r-2', paneId: '%4' } });
  });

  test('目标节点旧版本 → 不阻断，也不落授权', async () => {
    stubBridge(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    const session = newRemoteSession('%5');
    expect(await ensureSessionGrant(browserReq(), session)).toEqual({ ok: true, grant: null });
    expect(getAgentSessionById(session.id)?.remoteGrant).toBeNull();
  });

  test('先判成旧版本、随后被拒收 → 撤掉记忆并立刻重签', async () => {
    let issued = 0;
    let legacy = true;
    stubBridge(() => {
      if (legacy) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      issued += 1;
      return grantResponse(`u-${issued}`, 't');
    });
    const session = newRemoteSession('%8');
    expect(await ensureSessionGrant(browserReq(), session)).toEqual({ ok: true, grant: null });

    // 目标节点升级完成：RPC 被拒收即证明它在校验授权
    legacy = false;
    markSessionGrantStale(session.id);
    const again = getAgentSessionById(session.id);
    if (!again) throw new Error('session missing');
    expect(await ensureSessionGrant(browserReq(), again)).toMatchObject({
      ok: true,
      grant: { grantId: 'u-1' },
    });
  });

  test('浏览器缺目标节点会话 → 把 401 交回调用方', async () => {
    stubBridge(
      () => new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED' }), { status: 401 })
    );
    const session = newRemoteSession('%6');
    const ensured = await ensureSessionGrant(browserReq(), session);
    expect(ensured.ok).toBe(false);
    if (ensured.ok) throw new Error('unreachable');
    expect(ensured.response.status).toBe(401);
  });
});

describe('sessionPaneGrantSource', () => {
  test('load 读会话上的授权，reject 触发下一次重签', async () => {
    let issued = 0;
    stubBridge(() => {
      issued += 1;
      return grantResponse(`s-${issued}`, 'tok');
    });
    const session = newRemoteSession('%7');
    await ensureSessionGrant(browserReq(), session);

    const source = sessionPaneGrantSource(session.id);
    expect(await source.load()).toEqual({ grantId: 's-1', token: 'tok' });

    source.reject();
    const reloaded = getAgentSessionById(session.id);
    if (!reloaded) throw new Error('session missing');
    await ensureSessionGrant(browserReq(), reloaded);
    expect(await source.load()).toEqual({ grantId: 's-2', token: 'tok' });
  });
});
