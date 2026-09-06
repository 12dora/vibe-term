// 远程窗格授权的端到端：真实 LinkMux + 真实 mesh-internal 路由 + 真实签发路由。
// X（发起）与 Y（目标）在同一进程内，但每一次 RPC 都确实经过一条 mux 流：
// Y 只认「带得出授权」的调用，授权则由浏览器用自己的 Y 会话在建会话时换取。

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { ensureSessionGrant, resetPaneGrantClientForTests } from '../../agent/pane-grant/client';
import { createPaneGrantRoutes } from '../../agent/pane-grant/routes';
import { defaultPaneGrantVerifier } from '../../agent/pane-grant/rpc-guard';
import { defaultAgentRunDeps } from '../../agent/run-deps';
import type { AgentSupervisor } from '../../agent/supervisor';
import { createAgentRoutes } from '../../api/agent';
import { dispatchRoutes } from '../../api/route';
import { NodeSessionStore } from '../../auth';
import { UserStore } from '../../auth/user-store';
import { getAgentSessionById } from '../../db/agent';
import { getDb } from '../../db/client';
import { createDevice } from '../../db/devices';
import { runMigrations } from '../../db/migrate';
import { agentPaneGrants, agentSessions, devices } from '../../db/schema';
import { Forwarder } from '../forwarder';
import { setMeshAgentBridge } from '../mesh-agent-bridge';
import {
  type MeshInternalTmuxDeps,
  handleMeshInternalTmuxRequest,
  isMeshInternalPath,
} from '../mesh-internal-tmux-routes';
import { acceptHttpStream, openHttpStream, openWsStream } from '../stream-targets';
import { seedUser } from '../test-support';

const NODE_X = 'a'.repeat(32);
const NODE_Y = 'b'.repeat(32);
const DEVICE_Y = 'pane-grant-e2e-device';
const PANE = '%5';
const SERVER_EPOCH = new Uint8Array(16).fill(0x5a);

/** Y 侧的签发路由：设备与 tmux server 世代都由测试运行时给。 */
const targetGrantRoutes = createPaneGrantRoutes({
  deviceExists: (deviceId) => deviceId === DEVICE_Y,
  serverEpochOf: async () => serverEpochHex,
});

function fakeTmuxRuntime() {
  const state = {
    connected: true,
    writes: [] as Array<{ paneId: string; data: string }>,
    async connect() {
      state.connected = true;
    },
    isConnected: () => state.connected,
    async sendInputAndWait(paneId: string, data: string) {
      state.writes.push({ paneId, data });
    },
    async capturePaneText() {
      return 'remote-screen';
    },
    getServerEpoch: () => serverEpoch,
    async getPaneInfo() {
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'zsh',
      };
    },
  };
  return state;
}

let serverEpoch: Uint8Array | null = SERVER_EPOCH;
let serverEpochHex: string | null = Array.from(SERVER_EPOCH, (b) =>
  b.toString(16).padStart(2, '0')
).join('');
let runtime = fakeTmuxRuntime();
let sessionStore: NodeSessionStore;
let sid = '';
let links: [LinkSession, LinkSession] | null = null;

function tmuxDeps(overrides: Partial<MeshInternalTmuxDeps> = {}): MeshInternalTmuxDeps {
  return {
    acquire: async () => runtime,
    release: async () => {},
    deviceExists: () => true,
    verifyGrant: defaultPaneGrantVerifier,
    ...overrides,
  };
}

/** 目标节点 Y 的 HTTP 面：mesh-internal 走窗格路由，其余走 Y 的 API（含签发路由）。 */
async function dispatchNewTarget(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (isMeshInternalPath(path)) {
    return handleMeshInternalTmuxRequest(req, tmuxDeps());
  }
  const matched = dispatchRoutes(req, path, targetGrantRoutes, { path });
  return matched
    ? await matched
    : new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
}

/** 旧版本的 Y：没有签发路由，mesh-internal 也不校验授权。 */
async function dispatchOldTarget(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (isMeshInternalPath(path)) {
    return handleMeshInternalTmuxRequest(
      req,
      // 旧版本不校验授权，世代按运行时当前值放行
      tmuxDeps({ verifyGrant: () => ({ ok: true, grantId: null, serverEpoch: serverEpochHex }) })
    );
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
}

function connect(dispatch: (req: Request) => Promise<Response>): Forwarder {
  const [linkA, linkB] = createInMemoryLinkPair();
  links = [linkA, linkB];
  linkB.onStream((stream) => {
    void acceptHttpStream(stream, {
      peerNodeId: NODE_X,
      sessionStore,
      dispatchHttp: dispatch,
    });
  });
  const forwarder = new Forwarder({
    nodeId: NODE_X,
    peers: {
      getLink: async () => linkA,
      listReach: () => new Map(),
      onNodeEvent: () => () => {},
    },
    streams: {
      openHttpStream: (link, open, body, signal) =>
        openHttpStream(link, { type: 'http', ...open }, body, signal),
      openWsStream: openWsStream as never,
    },
    log: () => {},
  });
  setMeshAgentBridge({
    selfNodeId: NODE_X,
    lookupNode: () => 'online',
    forwardInternalHttp: (nodeId, path, body, signal) =>
      forwarder.forwardInternalHttp(nodeId, path, body, signal),
    forwardAuthorizedHttp: (req, input) => forwarder.forwardAuthorizedHttp(req, input),
  });
  return forwarder;
}

function browserRequest(withSession = true): Request {
  return new Request('http://localhost/api/agent/sessions', {
    method: 'POST',
    headers: withSession ? { cookie: `tmex_s_${NODE_Y}=${sid}` } : {},
  });
}

const stubSupervisor = { isSessionActive: () => false } as unknown as AgentSupervisor;

async function createSession(req = browserRequest()): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const body = JSON.stringify({
    nodeId: NODE_Y,
    deviceId: DEVICE_Y,
    paneId: PANE,
    modelId: 'mock-model',
  });
  const withBody = new Request(req, { method: 'POST', body });
  const res = dispatchRoutes(withBody, '/api/agent/sessions', createAgentRoutes(stubSupervisor), {
    path: '/api/agent/sessions',
  });
  if (!res) throw new Error('no route');
  const resolved = await res;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

async function sendInputThroughRuntime(sessionId: string, data: string): Promise<void> {
  const remote = await defaultAgentRunDeps.acquireRuntime(NODE_Y, DEVICE_Y, sessionId);
  await remote.sendInput(PANE, data);
}

describe('远程窗格授权（真实 peer 链路）', () => {
  beforeAll(() => {
    runMigrations();
    sessionStore = new NodeSessionStore(getDb());
    seedUser(new UserStore(getDb()), 'pane-grant-user');
    sid = sessionStore.issue({
      userId: 'pane-grant-user',
      viaNodeId: NODE_X,
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    }).sid;
  });

  beforeEach(() => {
    getDb().delete(agentPaneGrants).run();
    getDb().delete(agentSessions).run();
    getDb().delete(devices).run();
    resetPaneGrantClientForTests();
    serverEpoch = SERVER_EPOCH;
    runtime = fakeTmuxRuntime();
    const now = new Date().toISOString();
    createDevice({
      id: DEVICE_Y,
      name: 'remote-device',
      type: 'local',
      session: 'tmex-test',
      authMode: 'agent',
      port: 22,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    setMeshAgentBridge(null);
    links?.[0].close('test-done');
    links?.[1].close('test-done');
    links = null;
  });

  test('没有授权的对端调 send-input / capture / pane-info 一律 403', async () => {
    const forwarder = connect(dispatchNewTarget);
    for (const path of ['send-input', 'capture', 'pane-info']) {
      const res = await forwarder.forwardInternalHttp(NODE_Y, `/api/mesh-internal/tmux/${path}`, {
        deviceId: DEVICE_Y,
        paneId: PANE,
        data: 'rm -rf /\n',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('PANE_GRANT_REQUIRED');
    }
    expect(runtime.writes).toEqual([]);
  });

  test('浏览器建会话即换取授权，之后的 send-input 放行', async () => {
    connect(dispatchNewTarget);
    const created = await createSession();
    expect(created.status).toBe(201);
    const session = created.json.session as { id: string; originProcessName: string | null };
    // 建会话时的 pane-info 也走的授权闸，能取到进程名即已放行
    expect(session.originProcessName).toBe('zsh');
    expect(getAgentSessionById(session.id)?.remoteGrant).not.toBeNull();
    const stored = getDb().select().from(agentPaneGrants).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ fromNodeId: NODE_X, deviceId: DEVICE_Y, paneId: PANE });

    await sendInputThroughRuntime(session.id, 'echo grant\n');
    expect(runtime.writes).toEqual([{ paneId: PANE, data: 'echo grant\n' }]);
  });

  test('授权绑死窗格：换个窗格用同一张仍被拒', async () => {
    const forwarder = connect(dispatchNewTarget);
    const created = await createSession();
    const session = created.json.session as { id: string };
    const grant = getDb().select().from(agentPaneGrants).all()[0];
    if (!grant) throw new Error('grant missing');
    const stolen = await forwarder.forwardInternalHttp(
      NODE_Y,
      '/api/mesh-internal/tmux/send-input',
      {
        deviceId: DEVICE_Y,
        paneId: '%9',
        data: 'x',
        grant: { grantId: grant.id, token: 'not-the-token' },
      }
    );
    expect(stolen.status).toBe(403);
    expect(((await stolen.json()) as { code: string }).code).toBe('PANE_GRANT_INVALID');
    expect(getAgentSessionById(session.id)).not.toBeNull();
  });

  test('目标节点是旧版本：不带授权照常建会话与发送', async () => {
    connect(dispatchOldTarget);
    const created = await createSession();
    expect(created.status).toBe(201);
    const session = created.json.session as { id: string };
    expect(getAgentSessionById(session.id)?.remoteGrant).toBeNull();
    expect(getDb().select().from(agentPaneGrants).all()).toEqual([]);

    await sendInputThroughRuntime(session.id, 'legacy\n');
    expect(runtime.writes).toEqual([{ paneId: PANE, data: 'legacy\n' }]);
  });

  test('浏览器没有目标节点会话 → 401 NODE_LOGIN_REQUIRED，前端据此提示登录', async () => {
    connect(dispatchNewTarget);
    const created = await createSession(browserRequest(false));
    expect(created.status).toBe(401);
    expect(created.json).toMatchObject({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_Y });
    expect(getDb().select().from(agentSessions).all()).toEqual([]);
  });

  test('目标 tmux 重启（server 世代变了）→ 旧授权失效，下一次用户请求重签后恢复', async () => {
    connect(dispatchNewTarget);
    const created = await createSession();
    const session = created.json.session as { id: string };
    await sendInputThroughRuntime(session.id, 'before\n');
    expect(runtime.writes).toHaveLength(1);

    // tmux 重启：窗格号会重号，旧授权不该再指向新窗格
    const restarted = new Uint8Array(16).fill(0x77);
    serverEpoch = restarted;
    serverEpochHex = Array.from(restarted, (b) => b.toString(16).padStart(2, '0')).join('');
    await expect(sendInputThroughRuntime(session.id, 'after\n')).rejects.toThrow(
      'PANE_GRANT_INVALID'
    );
    expect(runtime.writes).toHaveLength(1);

    // 下一次带 cookie 的会话请求补签，绑定到新世代
    const stored = getAgentSessionById(session.id);
    if (!stored) throw new Error('session missing');
    const ensured = await ensureSessionGrant(browserRequest(), stored);
    expect(ensured.ok).toBe(true);
    await sendInputThroughRuntime(session.id, 'healed\n');
    expect(runtime.writes.at(-1)).toEqual({ paneId: PANE, data: 'healed\n' });
  });
});
