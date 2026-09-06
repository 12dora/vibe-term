// 改绑窗格：授权必须按将要写入的窗格先签好，再与绑定一起提交。
// 授权签不下来（浏览器没有目标节点会话）时会话一个字段都不能动，
// 提交时发现会话已被别处改过则整体作废——否则前端认为失败、后端已经换了绑定。

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { pendingGrantRevocations, resetPaneGrantClientForTests } from '../agent/pane-grant/client';
import type { AgentSupervisor } from '../agent/supervisor';
import { createAgentSession, getAgentSessionById, updateAgentSession } from '../db/agent';
import { getDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { agentSessions } from '../db/schema';
import { type MeshAgentBridge, setMeshAgentBridge } from '../mesh/mesh-agent-bridge';
import { createAgentSessionRoutes } from './agent-session-routes';
import { dispatchRoutes } from './route';

const NODE_X = 'a'.repeat(32);
const NODE_Y = 'b'.repeat(32);

let issued = 0;
let mintStatus: 'ok' | 'login-required' = 'ok';
const deletedGrants: string[] = [];
/** 提交前插一脚：模拟另一端在同一时刻改了会话。 */
let beforeCommit: (() => void) | null = null;

const bridge: MeshAgentBridge = {
  selfNodeId: NODE_X,
  lookupNode: () => 'online',
  forwardInternalHttp: async () => new Response('{}', { status: 200 }),
  forwardAuthorizedHttp: async (_req, input) => {
    if (input.method === 'DELETE') {
      deletedGrants.push(input.path);
      return new Response('{}', { status: 200 });
    }
    if (mintStatus === 'login-required') {
      return new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_Y }), {
        status: 401,
      });
    }
    issued += 1;
    beforeCommit?.();
    return new Response(
      JSON.stringify({ grantId: `g-${issued}`, token: 't', expiresAt: Date.now() + 86_400_000 }),
      { status: 201 }
    );
  },
};

const stubSupervisor = { isSessionActive: () => false } as unknown as AgentSupervisor;

async function patch(id: string, body: unknown): Promise<{ status: number; json: any }> {
  const path = `/api/agent/sessions/${id}`;
  const req = new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = dispatchRoutes(req, path, createAgentSessionRoutes(stubSupervisor), { path });
  if (!res) throw new Error('no route');
  const resolved = await res;
  return { status: resolved.status, json: await resolved.json() };
}

function newRemoteSession(paneId = '%1') {
  return createAgentSession({
    title: 'rebind',
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
  getDb().delete(agentSessions).run();
  resetPaneGrantClientForTests();
  issued = 0;
  mintStatus = 'ok';
  deletedGrants.length = 0;
  beforeCommit = null;
  setMeshAgentBridge(bridge);
});

afterEach(() => {
  setMeshAgentBridge(null);
});

describe('PATCH /api/agent/sessions/:id 改绑窗格', () => {
  test('签下新授权后与绑定一起提交，旧授权排队吊销', async () => {
    const session = newRemoteSession('%1');
    const first = await patch(session.id, { paneId: '%2' });
    expect(first.status).toBe(200);
    expect(first.json.session.paneId).toBe('%2');
    const stored = getAgentSessionById(session.id);
    expect(stored?.remoteGrant).not.toBeNull();

    const second = await patch(session.id, { paneId: '%3' });
    expect(second.status).toBe(200);
    expect(getAgentSessionById(session.id)?.paneId).toBe('%3');
    // 第一张已经被顶替：进队列，下一次带 cookie 的请求会 DELETE 掉
    expect(pendingGrantRevocations(NODE_Y)).toContain('g-1');
  });

  test('浏览器没有目标节点会话 → 401，且会话一个字段都没动', async () => {
    const session = newRemoteSession('%1');
    mintStatus = 'login-required';
    const before = getAgentSessionById(session.id);
    const res = await patch(session.id, { paneId: '%2', title: 'renamed' });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ code: 'NODE_LOGIN_REQUIRED' });
    const after = getAgentSessionById(session.id);
    expect(after?.paneId).toBe('%1');
    expect(after?.title).toBe(before?.title);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  test('提交时会话已被别处改绑 → 409，本次改动整体作废，刚签的授权排队吊销', async () => {
    const session = newRemoteSession('%1');
    beforeCommit = () => {
      updateAgentSession(session.id, { paneId: '%9' });
    };
    const res = await patch(session.id, { paneId: '%2' });
    expect(res.status).toBe(409);
    const after = getAgentSessionById(session.id);
    // 另一端写的那次留在库里，本次改绑整体作废
    expect(after?.paneId).toBe('%9');
    expect(after?.remoteGrant).toBeNull();
    expect(pendingGrantRevocations(NODE_Y)).toContain('g-1');
  });

  test('只改名不碰窗格：不去换授权', async () => {
    const session = newRemoteSession('%1');
    const res = await patch(session.id, { title: 'just a rename' });
    expect(res.status).toBe(200);
    expect(issued).toBe(0);
    expect(getAgentSessionById(session.id)?.title).toBe('just a rename');
  });
});
