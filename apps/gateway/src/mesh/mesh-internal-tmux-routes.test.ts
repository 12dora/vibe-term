import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { defaultPaneGrantVerifier } from '../agent/pane-grant/rpc-guard';
import { issuePaneGrant } from '../agent/pane-grant/store';
import { getDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { agentPaneGrants } from '../db/schema';
import type { PaneInfo } from '../tmux-client/capture-history';
import {
  type MeshInternalTmuxDeps,
  type MeshInternalTmuxRuntime,
  handleMeshInternalTmuxRequest,
} from './mesh-internal-tmux-routes';
import { X_VIBETERM_MESH_PEER } from './peer-request-marker';

function peerRequest(path: string, body: unknown, peer = 'peer-1'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [X_VIBETERM_MESH_PEER]: peer,
    },
    body: JSON.stringify(body),
  });
}

function fakeRuntime(): MeshInternalTmuxRuntime & {
  connectCalls: number;
  writes: Array<{ paneId: string; data: string }>;
  connected: boolean;
} {
  const state = {
    connectCalls: 0,
    writes: [] as Array<{ paneId: string; data: string }>,
    connected: false,
    async connect() {
      state.connectCalls += 1;
      state.connected = true;
    },
    isConnected() {
      return state.connected;
    },
    async sendInputAndWait(paneId: string, data: string) {
      if (!state.connected) {
        throw new Error('runtime not connected');
      }
      state.writes.push({ paneId, data });
    },
    async capturePaneText() {
      if (!state.connected) {
        throw new Error('runtime not connected');
      }
      return 'pane-text';
    },
    async getPaneInfo(): Promise<PaneInfo> {
      if (!state.connected) {
        throw new Error('runtime not connected');
      }
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };
  return state;
}

function fakeDeps(
  runtime: MeshInternalTmuxRuntime,
  overrides?: Partial<MeshInternalTmuxDeps>
): MeshInternalTmuxDeps {
  return {
    acquire: async () => runtime,
    release: async () => {},
    deviceExists: () => true,
    verifyGrant: () => ({ ok: true, grantId: null, serverEpoch: null }),
    ...overrides,
  };
}

describe('mesh-internal tmux routes', () => {
  test('无 peer 标记 → 403 且不要求 cookie', async () => {
    const res = await handleMeshInternalTmuxRequest(
      new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'd', paneId: '%1' }),
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FORBIDDEN' });
  });

  test('有标记但缺字段 → 400', async () => {
    const res = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/pane-info', { deviceId: '', paneId: '' })
    );
    expect(res.status).toBe(400);
  });

  test('paneId 含换行或空格 → 400', async () => {
    for (const paneId of ['%1\nkill-server', '%1 extra', '%1\n']) {
      const res = await handleMeshInternalTmuxRequest(
        peerRequest('/api/mesh-internal/tmux/send-input', {
          deviceId: 'dev-1',
          paneId,
          data: 'x',
        })
      );
      expect(res.status).toBe(400);
    }
  });

  test('historyLines 负数或超大 → 400', async () => {
    const runtime = fakeRuntime();
    for (const historyLines of [-1, 2001, 1.5, Number.POSITIVE_INFINITY]) {
      const res = await handleMeshInternalTmuxRequest(
        peerRequest('/api/mesh-internal/tmux/capture', {
          deviceId: 'dev-1',
          paneId: '%1',
          historyLines,
        }),
        fakeDeps(runtime)
      );
      expect(res.status).toBe(400);
    }
  });

  test('device 不存在 → 404', async () => {
    const runtime = fakeRuntime();
    const res = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/pane-info', { deviceId: 'missing', paneId: '%1' }),
      fakeDeps(runtime, { deviceExists: () => false })
    );
    expect(res.status).toBe(404);
    expect(runtime.connectCalls).toBe(0);
  });

  test('registry 无预存 runtime 时三条 RPC 均 connect 且输入到达 pane', async () => {
    const runtime = fakeRuntime();
    const acquired: MeshInternalTmuxRuntime[] = [];
    const released: MeshInternalTmuxRuntime[] = [];
    const deps = fakeDeps(runtime, {
      acquire: async () => {
        acquired.push(runtime);
        return runtime;
      },
      release: async (_id, handle) => {
        released.push(handle);
        runtime.connected = false;
      },
    });

    const info = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/pane-info', { deviceId: 'dev-1', paneId: '%3' }),
      deps
    );
    expect(info.status).toBe(200);
    expect(((await info.json()) as { info: { cols: number } }).info.cols).toBe(80);

    const capture = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/capture', {
        deviceId: 'dev-1',
        paneId: '%3',
        historyLines: 0,
      }),
      deps
    );
    expect(capture.status).toBe(200);
    expect(await capture.json()).toEqual({ text: 'pane-text' });

    const send = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/send-input', {
        deviceId: 'dev-1',
        paneId: '%3',
        data: 'echo hi\n',
      }),
      deps
    );
    expect(send.status).toBe(200);
    expect(await send.json()).toEqual({ ok: true });
    expect(runtime.connectCalls).toBe(3);
    expect(runtime.writes).toEqual([{ paneId: '%3', data: 'echo hi\n' }]);
    expect(acquired).toHaveLength(3);
    expect(released).toHaveLength(3);
  });

  test('未连接时 send-input 返回错误而不是 ok', async () => {
    const runtime = fakeRuntime();
    runtime.connect = async () => {
      runtime.connectCalls += 1;
    };
    const res = await handleMeshInternalTmuxRequest(
      peerRequest('/api/mesh-internal/tmux/send-input', {
        deviceId: 'dev-1',
        paneId: '%1',
        data: 'x',
      }),
      fakeDeps(runtime)
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'runtime not connected' });
    expect(runtime.writes).toEqual([]);
  });
});

const GRANT_NODE_X = 'a'.repeat(32);
const GRANT_NODE_Z = 'c'.repeat(32);
const GRANT_DEVICE = 'grant-rpc-device';
const GRANT_EPOCH = new Uint8Array(16).fill(0xab);
const GRANT_EPOCH_HEX = 'ab'.repeat(16);

/** 真授权账本（不 stub verifyGrant），验证三条 RPC 的闸门确实接在存储上。 */
describe('mesh-internal tmux routes: 窗格授权闸', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    getDb().delete(agentPaneGrants).run();
  });

  function realDeps(runtime: MeshInternalTmuxRuntime): MeshInternalTmuxDeps {
    return {
      acquire: async () => runtime,
      release: async () => {},
      deviceExists: () => true,
      verifyGrant: defaultPaneGrantVerifier,
    };
  }

  /** 带 server 世代的假运行时：世代变了就等于 tmux 重启过。 */
  function epochRuntime(epoch: Uint8Array | null = GRANT_EPOCH) {
    const runtime = fakeRuntime() as ReturnType<typeof fakeRuntime> & {
      getServerEpoch(): Uint8Array | null;
    };
    runtime.getServerEpoch = () => epoch;
    return runtime;
  }

  function issue(
    overrides: { fromNodeId?: string; paneId?: string; now?: number; serverEpoch?: string } = {}
  ) {
    return issuePaneGrant({
      fromNodeId: overrides.fromNodeId ?? GRANT_NODE_X,
      deviceId: GRANT_DEVICE,
      paneId: overrides.paneId ?? '%3',
      serverEpoch: overrides.serverEpoch ?? GRANT_EPOCH_HEX,
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    });
  }

  const PATHS = [
    '/api/mesh-internal/tmux/pane-info',
    '/api/mesh-internal/tmux/capture',
    '/api/mesh-internal/tmux/send-input',
  ] as const;

  function bodyFor(path: string, grant?: { grantId: string; token: string }) {
    return {
      deviceId: GRANT_DEVICE,
      paneId: '%3',
      ...(path.endsWith('/send-input') ? { data: 'x' } : {}),
      ...(grant ? { grant: { grantId: grant.grantId, token: grant.token } } : {}),
    };
  }

  test('缺授权 → 403 PANE_GRANT_REQUIRED（三条 RPC 都拦）', async () => {
    const runtime = fakeRuntime();
    for (const path of PATHS) {
      const res = await handleMeshInternalTmuxRequest(
        peerRequest(path, bodyFor(path), GRANT_NODE_X),
        realDeps(runtime)
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'PANE_GRANT_REQUIRED',
        code: 'PANE_GRANT_REQUIRED',
      });
    }
    expect(runtime.connectCalls).toBe(0);
  });

  test('授权有效 → 放行', async () => {
    const runtime = epochRuntime();
    const grant = issue();
    for (const path of PATHS) {
      const res = await handleMeshInternalTmuxRequest(
        peerRequest(path, bodyFor(path, grant), GRANT_NODE_X),
        realDeps(runtime)
      );
      expect(res.status).toBe(200);
    }
    expect(runtime.writes).toEqual([{ paneId: '%3', data: 'x' }]);
  });

  test('别的节点拿着授权 / 换窗格 / 已过期 → 403 PANE_GRANT_INVALID', async () => {
    const runtime = epochRuntime();
    const grant = issue();

    const wrongPeer = await handleMeshInternalTmuxRequest(
      peerRequest(PATHS[2], bodyFor(PATHS[2], grant), GRANT_NODE_Z),
      realDeps(runtime)
    );
    expect(wrongPeer.status).toBe(403);
    expect(((await wrongPeer.json()) as { code: string }).code).toBe('PANE_GRANT_INVALID');

    const otherPane = await handleMeshInternalTmuxRequest(
      peerRequest(PATHS[2], { ...bodyFor(PATHS[2], grant), paneId: '%9' }, GRANT_NODE_X),
      realDeps(runtime)
    );
    expect(otherPane.status).toBe(403);

    const expired = issue({ paneId: '%4', now: Date.now() - 40 * 24 * 60 * 60 * 1000 });
    const stale = await handleMeshInternalTmuxRequest(
      peerRequest(PATHS[2], { ...bodyFor(PATHS[2], expired), paneId: '%4' }, GRANT_NODE_X),
      realDeps(runtime)
    );
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe('PANE_GRANT_INVALID');
    expect(runtime.writes).toEqual([]);
  });

  test('伪造 token → 403，且不触碰 runtime', async () => {
    const runtime = epochRuntime();
    const grant = issue();
    const res = await handleMeshInternalTmuxRequest(
      peerRequest(
        PATHS[1],
        bodyFor(PATHS[1], { grantId: grant.grantId, token: 'f'.repeat(64) }),
        GRANT_NODE_X
      ),
      realDeps(runtime)
    );
    expect(res.status).toBe(403);
    expect(runtime.connectCalls).toBe(0);
  });

  test('tmux 重启（server 世代变了）→ 403，并当场作废这张授权', async () => {
    const grant = issue();
    const restarted = epochRuntime(new Uint8Array(16).fill(0x11));
    const res = await handleMeshInternalTmuxRequest(
      peerRequest(PATHS[2], bodyFor(PATHS[2], grant), GRANT_NODE_X),
      realDeps(restarted)
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PANE_GRANT_INVALID');
    expect(restarted.writes).toEqual([]);
    // 作废之后连原世代的运行时也不再放行，必须重签
    const again = await handleMeshInternalTmuxRequest(
      peerRequest(PATHS[2], bodyFor(PATHS[2], grant), GRANT_NODE_X),
      realDeps(epochRuntime())
    );
    expect(again.status).toBe(403);
  });
});
