// 陈旧会话（入口换过 node id，`tmex_s_<target>` 还留着旧入口签发的那只）的自愈：
// 列表把该 node 报成 loggedIn:true，设备请求却回 401 NODE_LOGIN_REQUIRED
// → 补一次静默重登 → 成功就回源；失败才把它标未登录，让界面退回登录入口。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { ApiError, NODE_UNREACHABLE } = await import('@tmex/api-client');
const { getMeshNodesState, resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import(
  './mesh-nodes'
);
const { handleNodeApiError, resetNodeSessionRecovery, resetNodeSessionRecoveryForTest } =
  await import('./node-session-recovery');

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: ENTRY,
  uid: 'user-1',
  username: 'alice',
  kdfParams: null,
  passkeyAvailable: false,
  passkeysForThisOrigin: false,
};

function meshNode(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: 'AAAA',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

/** 列表说「已登录」——正是陈旧 cookie 造成的假象。 */
function seedLoggedInNode(): void {
  setMeshNodesStateForTest({
    mode: MESH_MODE,
    modeLoaded: true,
    entryNodeId: ENTRY,
    nodes: [meshNode({ id: NODE_A, loggedIn: true })],
    loadedAt: Date.now(),
  });
}

function loginRequired(): unknown {
  return new ApiError(401, 'via_mismatch', {
    code: 'NODE_LOGIN_REQUIRED',
    error: 'via_mismatch',
    nodeId: NODE_A,
  });
}

function loggedInOf(nodeId: string): boolean | undefined {
  return getMeshNodesState().nodes.find((node) => node.id === nodeId)?.loggedIn;
}

afterEach(() => {
  resetMeshNodesStateForTest();
  resetNodeSessionRecoveryForTest();
});

describe('handleNodeApiError', () => {
  test('陈旧会话：重登一次并回源，登录态保持不变（不闪断）', async () => {
    seedLoggedInNode();
    const calls: string[] = [];
    let refetched = 0;

    const outcome = await handleNodeApiError(NODE_A, loginRequired(), {
      login: (nodeId) => {
        calls.push(nodeId);
        return Promise.resolve({ ok: true });
      },
      onRecovered: () => {
        refetched += 1;
      },
    });

    expect(outcome).toBe('recovered');
    expect(calls).toEqual([NODE_A]);
    expect(refetched).toBe(1);
    expect(loggedInOf(NODE_A)).toBe(true);
  });

  test('同一轮失效只重登一次：第二次 401 直接跳过', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: true });
    };

    await handleNodeApiError(NODE_A, loginRequired(), { login });
    const second = await handleNodeApiError(NODE_A, loginRequired(), { login });

    expect(logins).toBe(1);
    expect(second).toBe('skipped');
  });

  test('并发的两次 401 合并成同一次重登', async () => {
    seedLoggedInNode();
    let logins = 0;
    let release: () => void = () => undefined;
    const login = () => {
      logins += 1;
      return new Promise<{ ok: boolean }>((resolve) => {
        release = () => resolve({ ok: true });
      });
    };

    const first = handleNodeApiError(NODE_A, loginRequired(), { login });
    const second = handleNodeApiError(NODE_A, loginRequired(), { login });
    release();

    expect(await first).toBe('recovered');
    expect(await second).toBe('recovered');
    expect(logins).toBe(1);
  });

  test('请求重新成功后解除记账，下一轮失效可以再自愈', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: true });
    };

    await handleNodeApiError(NODE_A, loginRequired(), { login });
    resetNodeSessionRecovery(NODE_A);
    await handleNodeApiError(NODE_A, loginRequired(), { login });

    expect(logins).toBe(2);
  });

  test('重登被凭证类原因拒掉：标未登录，界面退回登录入口', async () => {
    seedLoggedInNode();
    const outcome = await handleNodeApiError(NODE_A, loginRequired(), {
      login: () => Promise.resolve({ ok: false, code: 'NO_SESSION_KEY' }),
    });

    expect(outcome).toBe('failed');
    expect(loggedInOf(NODE_A)).toBe(false);
  });

  test('网络类失败不动登录态：一次 401 不足以判会话作废', async () => {
    seedLoggedInNode();
    const outcome = await handleNodeApiError(NODE_A, loginRequired(), {
      login: () => Promise.resolve({ ok: false, code: 'NETWORK_ERROR' }),
    });

    expect(outcome).toBe('failed');
    expect(loggedInOf(NODE_A)).toBe(true);
  });

  test('重登实现抛错时也给结论，不留在途记录', async () => {
    seedLoggedInNode();
    const outcome = await handleNodeApiError(NODE_A, loginRequired(), {
      login: () => Promise.reject(new Error('boom')),
    });

    expect(outcome).toBe('failed');
    expect(loggedInOf(NODE_A)).toBe(true);
  });

  test('其它失败与 entry 自身一律不管', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: true });
    };

    const unreachable = new ApiError(503, NODE_UNREACHABLE, { code: NODE_UNREACHABLE });
    expect(await handleNodeApiError(NODE_A, unreachable, { login })).toBe('ignored');
    expect(await handleNodeApiError(NODE_A, new Error('boom'), { login })).toBe('ignored');
    expect(await handleNodeApiError('self', loginRequired(), { login })).toBe('ignored');
    expect(logins).toBe(0);
    expect(loggedInOf(NODE_A)).toBe(true);
  });
});
