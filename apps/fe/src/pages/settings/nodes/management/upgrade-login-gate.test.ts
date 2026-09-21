// 升级遇到「须先登录」时的前置登录，以及批量跳过原因的分类计数。
//
// 现网那次「升级也失败」的形状：入口 POST 吃到 401 `NODE_LOGIN_REQUIRED`，前端直接报
// 「升级失败：须先登录该节点。」，而行里的 `loggedIn` 仍是 true（过期 cookie），按钮照亮，
// 用户反复点、反复失败。这里覆盖修好之后的两条路：静默补登成功接着升级；补登失败按原因分开说。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setNodeLoginRetryTimersForTest } from '@/auth/node-login-retry';
import type { LoginNodeResult } from '@/auth/session-key-store';
import {
  type NodeRow,
  getMeshNodesState,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
} from '@/node/mesh-nodes';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { NO_UPGRADE_SKIPS, batchSkipText, upgradeSkipCounts } from './upgrade-batch';
import {
  type UpgradeIo,
  type UpgradeStartOutcome,
  type UpgradeToasts,
  runNodeUpgrade,
  startUpgradeWithLogin,
  upgradeErrorText,
  upgradeStartFailureToast,
} from './use-node-upgrade';

installWindowStorage();

const NODE_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function row(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: NODE_ID,
    runtimeNodeId: NODE_ID,
    name: 'node-a',
    publicKey: '',
    fingerprint: '',
    online: true,
    reach: 'lan',
    transport: null,
    rttMs: null,
    version: '2.0.0',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  } as NodeRow;
}

function stubIo(overrides: Partial<UpgradeIo> = {}): UpgradeIo {
  return {
    start: async () => ({ kind: 'cancelled' }) as UpgradeStartOutcome,
    login: async () => ({ ok: true }) as LoginNodeResult,
    poll: async () => ({ kind: 'unreachable' }),
    cancel: async () => ({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 }),
    nodeVersion: async () => undefined,
    wait: async () => true,
    now: () => 0,
    ...overrides,
  };
}

interface Recorder {
  toasts: UpgradeToasts;
  log: Array<[keyof UpgradeToasts, string]>;
}

function recorder(): Recorder {
  const log: Array<[keyof UpgradeToasts, string]> = [];
  return {
    log,
    toasts: {
      success: (m) => log.push(['success', m]),
      info: (m) => log.push(['info', m]),
      warning: (m) => log.push(['warning', m]),
      error: (m) => log.push(['error', m]),
    },
  };
}

function params(io: UpgradeIo, extra: { toasts?: UpgradeToasts } = {}) {
  const controller = new AbortController();
  return {
    row: row(),
    targetVersion: '2.1.0',
    io,
    signal: controller.signal,
    t,
    toasts: extra.toasts ?? recorder().toasts,
    patch: () => undefined,
    onChanged: () => undefined,
  };
}

/** 入口给出的 401：`loggedIn` 那只 cookie 过期了，但列表仍报已登录。 */
function loginRequired(): UpgradeStartOutcome {
  return { kind: 'failed', code: 'NODE_LOGIN_REQUIRED' };
}

beforeEach(() => {
  setNodeLoginRetryTimersForTest({
    schedule: () => null,
    cancel: () => undefined,
    random: () => 0,
  });
  setMeshNodesStateForTest({
    nodes: [
      {
        id: NODE_ID,
        name: 'node-a',
        publicKey: 'AAAA',
        online: true,
        reach: 'lan',
        version: '2.0.0',
        direct_capable: false,
        inventory: null,
        loggedIn: true,
      },
    ],
  });
});

afterEach(() => {
  setNodeLoginRetryTimersForTest(null);
  resetMeshNodesStateForTest();
});

describe('startUpgradeWithLogin', () => {
  test('不需要登录时一次都不补登：POST 只发一发', async () => {
    const starts: number[] = [];
    let logins = 0;
    const io = stubIo({
      start: async () => {
        starts.push(1);
        return {
          kind: 'started',
          status: { state: 'downloading', targetVersion: '2.1.0', error: null, startedAt: null },
        };
      },
      login: async () => {
        logins += 1;
        return { ok: true };
      },
    });
    const outcome = await startUpgradeWithLogin(params(io));
    expect(outcome.kind).toBe('started');
    expect(starts).toHaveLength(1);
    expect(logins).toBe(0);
  });

  test('静默补登成功：接着重发一次 POST，升级照常开始', async () => {
    let starts = 0;
    const io = stubIo({
      start: async () => {
        starts += 1;
        if (starts === 1) return loginRequired();
        return {
          kind: 'started',
          status: { state: 'downloading', targetVersion: '2.1.0', error: null, startedAt: null },
        };
      },
      login: async () => ({ ok: true }),
    });
    const outcome = await startUpgradeWithLogin(params(io));
    expect(outcome.kind).toBe('started');
    expect(starts).toBe(2);
  });

  test('补登成功后目标仍回 401：只重发一次，不再死循环', async () => {
    let starts = 0;
    const io = stubIo({
      start: async () => {
        starts += 1;
        return loginRequired();
      },
      login: async () => ({ ok: true }),
    });
    const outcome = await startUpgradeWithLogin(params(io));
    expect(outcome).toEqual({ kind: 'failed', code: 'NODE_LOGIN_REQUIRED' });
    expect(starts).toBe(2);
  });

  test('补登败在凭证：判 NODE_LOGIN_REQUIRED，并把这一行就地标成未登录', async () => {
    const io = stubIo({
      start: async () => loginRequired(),
      login: async () => ({ ok: false, code: 'NO_SESSION_KEY' }),
    });
    const outcome = await startUpgradeWithLogin(params(io));
    expect(outcome).toEqual({ kind: 'failed', code: 'NODE_LOGIN_REQUIRED' });
    // 这是一次真的登录尝试给出的判决，行里的「登录该节点」按钮因此出得来。
    expect(getMeshNodesState().nodes[0].loggedIn).toBe(false);
  });

  test('补登败在传输层：说连接不上，且绝不把这一行标成未登录', async () => {
    const io = stubIo({
      start: async () => loginRequired(),
      login: async () => ({ ok: false, code: 'NODE_UNREACHABLE' }),
    });
    const outcome = await startUpgradeWithLogin(params(io));
    expect(outcome).toEqual({ kind: 'failed', code: 'NODE_UNREACHABLE_LOGIN' });
    expect(upgradeErrorText(t, 'NODE_UNREACHABLE_LOGIN')).toBe('nodes.upgrade.unreachable');
    expect(getMeshNodesState().nodes[0].loggedIn).toBe(true);
  });

  test('补登途中被取消：不报失败，交回 cancelled', async () => {
    const controller = new AbortController();
    const io = stubIo({
      start: async () => loginRequired(),
      login: async () => {
        controller.abort();
        return { ok: false, code: 'NO_SESSION_KEY' };
      },
    });
    const outcome = await startUpgradeWithLogin({ ...params(io), signal: controller.signal });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(getMeshNodesState().nodes[0].loggedIn).toBe(true);
  });
});

describe('upgradeStartFailureToast', () => {
  test('须先登录这一档要说清下一步在哪儿点', () => {
    expect(upgradeStartFailureToast(t, 'node-a', 'NODE_LOGIN_REQUIRED', 'x')).toBe(
      'nodes.upgrade.failedNeedsLogin:{"name":"node-a"}'
    );
  });

  test('其余沿用「升级失败：<原因>」', () => {
    expect(upgradeStartFailureToast(t, 'node-a', 'NODE_UNREACHABLE_LOGIN', 'boom')).toBe(
      'nodes.upgrade.failed:{"error":"boom"}'
    );
  });
});

describe('runNodeUpgrade 的 toast', () => {
  test('凭证类补登失败：toast 指向该行的登录入口，而不是笼统一句「升级失败」', async () => {
    const rec = recorder();
    const io = stubIo({
      start: async () => loginRequired(),
      login: async () => ({ ok: false, code: 'PASSKEY_REQUIRED' }),
    });
    const outcome = await runNodeUpgrade(params(io, { toasts: rec.toasts }));
    expect(outcome).toBe('failed');
    expect(rec.log).toEqual([['error', 'nodes.upgrade.failedNeedsLogin:{"name":"node-a"}']]);
  });

  test('传输层补登失败：toast 说连接不上，不谈登录', async () => {
    const rec = recorder();
    const io = stubIo({
      start: async () => loginRequired(),
      login: async () => ({ ok: false, code: 'NETWORK_ERROR' }),
    });
    const outcome = await runNodeUpgrade(params(io, { toasts: rec.toasts }));
    expect(outcome).toBe('failed');
    expect(rec.log).toEqual([
      ['error', 'nodes.upgrade.failed:{"error":"nodes.upgrade.unreachable"}'],
    ]);
  });
});

describe('批量跳过的原因计数', () => {
  const rows = [
    row({ id: 'a', name: 'a', online: false, version: '2.0.0' }),
    row({ id: 'b', name: 'b', online: false, version: '2.0.0' }),
    row({ id: 'c', name: 'c', loggedIn: false, version: '2.0.0' }),
    row({ id: 'd', name: 'd', version: '2.0.0' }),
    row({ id: 'e', name: 'e', version: '2.1.0' }),
  ];

  test('离线算「连不上」，没会话算「须先登录」；可升级与已最新都不算跳过', () => {
    expect(upgradeSkipCounts(rows, '2.1.0')).toEqual({ unreachable: 2, loginRequired: 1 });
  });

  test('已暂停的节点不进计数：它本来就不参与批量', () => {
    const paused = [...rows, row({ id: 'f', name: 'f', online: false, paused: true })];
    expect(upgradeSkipCounts(paused, '2.1.0').unreachable).toBe(2);
  });

  test('两类分开说，一类为 0 时不报那句废话', () => {
    expect(batchSkipText(t, { unreachable: 2, loginRequired: 1 })).toBe(
      'nodes.upgrade.skippedBoth:{"unreachable":2,"loginRequired":1}'
    );
    expect(batchSkipText(t, { unreachable: 2, loginRequired: 0 })).toBe(
      'nodes.upgrade.skippedUnreachable:{"count":2}'
    );
    expect(batchSkipText(t, { unreachable: 0, loginRequired: 3 })).toBe(
      'nodes.upgrade.skippedLoginRequired:{"count":3}'
    );
    expect(batchSkipText(t, NO_UPGRADE_SKIPS)).toBe('');
  });
});
