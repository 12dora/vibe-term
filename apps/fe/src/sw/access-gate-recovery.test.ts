// 启动期访问门兜底：只认服务端访问门的 403，认出就注销 SW 并刷新一次；
// 业务自己的 403、非 /api 路径、未被 SW 控制的页面都不该触发。

import { describe, expect, test } from 'bun:test';
import {
  type AccessGateWatchDeps,
  isAccessGateBody,
  recoverFromAccessGate,
  watchAccessGate,
} from './access-gate-recovery';

const ACCESS_DENIED = JSON.stringify({ error: { code: 'access_denied' } });
const DOMAIN_DISABLED = JSON.stringify({
  error: { code: 'DOMAIN_ACCESS_DISABLED', message: '域名访问已关闭' },
});

function harness(overrides: Partial<AccessGateWatchDeps> = {}) {
  let hook: ((res: Response, ctx: { pathname: string }) => void) | null = null;
  const state = { reloads: 0, unregistered: 0, guard: null as string | null };
  const deps: AccessGateWatchDeps = {
    controlled: true,
    addResponseHook: (next) => {
      hook = next;
      return () => {
        hook = null;
      };
    },
    unregisterAll: async () => {
      state.unregistered += 1;
    },
    reload: () => {
      state.reloads += 1;
    },
    readGuard: () => state.guard,
    writeGuard: () => {
      state.guard = '1';
    },
    ...overrides,
  };
  return {
    deps,
    state,
    emit: (status: number, body: string, pathname = '/api/auth/mode') =>
      hook?.(new Response(body, { status }), { pathname }),
    hooked: () => hook !== null,
  };
}

describe('isAccessGateBody', () => {
  test('认出隧道访问门与域名访问开关的错误码', () => {
    expect(isAccessGateBody(ACCESS_DENIED)).toBe(true);
    expect(isAccessGateBody(DOMAIN_DISABLED)).toBe(true);
  });

  test('业务自己的 403 不算访问门', () => {
    expect(isAccessGateBody(JSON.stringify({ error: { code: 'FORBIDDEN' } }))).toBe(false);
    expect(isAccessGateBody('')).toBe(false);
  });
});

describe('recoverFromAccessGate', () => {
  test('首次触发：注销 SW 后刷新并落守卫', async () => {
    const h = harness();
    expect(await recoverFromAccessGate(h.deps)).toBe(true);
    expect(h.state.unregistered).toBe(1);
    expect(h.state.reloads).toBe(1);
    expect(h.state.guard).toBe('1');
  });

  test('本会话已刷过就不再刷（杜绝刷新循环）', async () => {
    const h = harness();
    h.state.guard = '1';
    expect(await recoverFromAccessGate(h.deps)).toBe(false);
    expect(h.state.reloads).toBe(0);
  });
});

describe('watchAccessGate', () => {
  test('访问门 403 → 注销 + 刷新，并卸载观察者', async () => {
    const h = harness();
    watchAccessGate(h.deps);
    h.emit(403, ACCESS_DENIED);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.unregistered).toBe(1);
    expect(h.state.reloads).toBe(1);
    expect(h.hooked()).toBe(false);
  });

  test('域名访问关闭的 403 同样触发', async () => {
    const h = harness();
    watchAccessGate(h.deps);
    h.emit(403, DOMAIN_DISABLED);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.reloads).toBe(1);
  });

  test('业务 403 不刷新', async () => {
    const h = harness();
    watchAccessGate(h.deps);
    h.emit(403, JSON.stringify({ error: { code: 'FORBIDDEN' } }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.reloads).toBe(0);
  });

  test('启动正常（首个 /api 响应非 403）时立即自卸', () => {
    const h = harness();
    watchAccessGate(h.deps);
    h.emit(200, '{}');
    expect(h.hooked()).toBe(false);
    expect(h.state.reloads).toBe(0);
  });

  test('非 /api 路径不消耗观察窗口', () => {
    const h = harness();
    watchAccessGate(h.deps);
    h.emit(403, ACCESS_DENIED, '/n/abc/foo');
    expect(h.hooked()).toBe(true);
  });

  test('页面未被 SW 控制时根本不装钩子', () => {
    const h = harness({ controlled: false });
    watchAccessGate(h.deps);
    expect(h.hooked()).toBe(false);
  });

  test('返回的卸载函数可提前摘掉观察者', () => {
    const h = harness();
    watchAccessGate(h.deps)();
    expect(h.hooked()).toBe(false);
  });
});
