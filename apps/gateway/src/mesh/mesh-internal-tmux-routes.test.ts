import { describe, expect, test } from 'bun:test';
import type { PaneInfo } from '../tmux-client/capture-history';
import {
  type MeshInternalTmuxDeps,
  type MeshInternalTmuxRuntime,
  handleMeshInternalTmuxRequest,
} from './mesh-internal-tmux-routes';
import { X_TMEX_MESH_PEER } from './peer-request-marker';

function peerRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [X_TMEX_MESH_PEER]: 'peer-1',
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
