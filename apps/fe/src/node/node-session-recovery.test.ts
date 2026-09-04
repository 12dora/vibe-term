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
const {
  handleNodeApiError,
  needsUserSignIn,
  noteNodeQuerySuccess,
  resetNodeSessionRecoveryForTest,
} = await import('./node-session-recovery');

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
    noteNodeQuerySuccess(NODE_A, 2000);
    await handleNodeApiError(NODE_A, loginRequired(), { login });

    expect(logins).toBe(2);
  });

  test('缓存态 → 401 → 重登 → 回源仍失败：不再重登，也不空转', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: true });
    };

    // 缓存里已有一份列表（后台刷新失败时 react-query 会一直留着它）。
    noteNodeQuerySuccess(NODE_A, 1000);
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('recovered');

    // 回源那一次仍然 401：dataUpdatedAt 没有前进，记账不该解除。
    noteNodeQuerySuccess(NODE_A, 1000);
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('skipped');
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('skipped');
    expect(logins).toBe(1);

    // 直到真的又拉到一份新列表，下一轮失效才重新自愈。
    noteNodeQuerySuccess(NODE_A, 2000);
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('recovered');
    expect(logins).toBe(2);
  });

  test('留着旧数据（dataUpdatedAt 不变）不算成功，重复上报也不解除记账', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: true });
    };

    noteNodeQuerySuccess(NODE_A, 1000);
    await handleNodeApiError(NODE_A, loginRequired(), { login });
    for (let i = 0; i < 3; i += 1) noteNodeQuerySuccess(NODE_A, 1000);
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('skipped');
    expect(logins).toBe(1);
  });

  test.each([
    ['NO_SESSION_KEY'],
    ['PASSKEY_REQUIRED'],
    ['TOTP_REQUIRED'],
    ['NODE_PK_MISMATCH'],
    ['INVALID_CREDENTIALS'],
    ['PASSKEY_INVALID'],
  ])('需要用户介入的 %s：标未登录并保留记账', async (code) => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.resolve({ ok: false, code });
    };

    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('failed');
    expect(loggedInOf(NODE_A)).toBe(false);
    // 用户没做任何事之前重发也不该再撞一次登录端点。
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('skipped');
    expect(logins).toBe(1);
  });

  test.each([['NETWORK_ERROR'], ['NODE_LIST_FAILED'], ['RATE_LIMITED'], ['SOME_NEW_CODE']])(
    '临时失败 %s：不动登录态，用户重试还能再登一次',
    async (code) => {
      seedLoggedInNode();
      let logins = 0;
      const login = () => {
        logins += 1;
        return Promise.resolve({ ok: false, code });
      };

      expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('failed');
      expect(loggedInOf(NODE_A)).toBe(true);
      // 面板上的「重试」会重发请求、再撞 401：这一次必须还能重登，不能被记账挡死。
      expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('failed');
      expect(logins).toBe(2);
    }
  );

  test('重登实现抛错时也给结论，且记账当场解除', async () => {
    seedLoggedInNode();
    let logins = 0;
    const login = () => {
      logins += 1;
      return Promise.reject(new Error('boom'));
    };

    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('failed');
    expect(loggedInOf(NODE_A)).toBe(true);
    expect(await handleNodeApiError(NODE_A, loginRequired(), { login })).toBe('failed');
    expect(logins).toBe(2);
  });

  test('needsUserSignIn 只认凭证 / 二次验证类的码', () => {
    expect(needsUserSignIn('NO_SESSION_KEY')).toBe(true);
    expect(needsUserSignIn('DELEGATION_EXPIRED')).toBe(true);
    expect(needsUserSignIn('RATE_LIMITED')).toBe(false);
    expect(needsUserSignIn('CHALLENGE_EXPIRED')).toBe(false);
    expect(needsUserSignIn('UNKNOWN_NODE')).toBe(false);
    expect(needsUserSignIn(undefined)).toBe(false);
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
