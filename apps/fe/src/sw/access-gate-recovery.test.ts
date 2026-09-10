// 启动期访问门兜底：只认服务端访问门的 403，认出就注销 SW 并刷新一次；
// 业务自己的 403、非 /api 路径、未被 SW 控制的页面都不该触发。

import { describe, expect, test } from 'bun:test';
import {
  type AccessGateWatchDeps,
  installAccessGateGuards,
  isAccessGateBody,
  isAccessGateProbeResponse,
  probeAccessGate,
  recoverFromAccessGate,
  watchAccessGate,
} from './access-gate-recovery';

const ACCESS_DENIED = JSON.stringify({ error: { code: 'access_denied' } });
const DOMAIN_DISABLED = JSON.stringify({
  error: { code: 'DOMAIN_ACCESS_DISABLED', message: '域名访问已关闭' },
});

function harness(overrides: Partial<AccessGateWatchDeps> = {}) {
  let hook: ((res: Response, ctx: { pathname: string }) => void) | null = null;
  const state = { reloads: 0, unregistered: 0, guard: null as string | null, probes: 0 };
  const deps: AccessGateWatchDeps = {
    controlled: true,
    probe: async () => {
      state.probes += 1;
      return { type: 'basic', status: 200 };
    },
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

  test('按 error.code 精确比对，业务字段里恰好出现同名串不算', () => {
    expect(
      isAccessGateBody(
        JSON.stringify({ error: { code: 'FORBIDDEN', message: 'reason: access_denied' } })
      )
    ).toBe(false);
    expect(isAccessGateBody(JSON.stringify({ code: 'access_denied' }))).toBe(false);
    expect(isAccessGateBody(JSON.stringify({ error: { code: 123 } }))).toBe(false);
  });

  test('解析不出信封的 403 一律不当访问门（不能因为一张 HTML 错误页就注销 SW）', () => {
    // 域名访问关闭时的纯文本页（apps/gateway/src/api/domain-access-routes.ts 的
    // DOMAIN_ACCESS_DISABLED_TEXT）本身并不含错误码，而且 /api/** 恒走 deny-json 分支
    // （domain-access-policy.ts 的 isJsonDeniedPath），根本到不了这里。
    expect(isAccessGateBody('Domain access is disabled for this host.')).toBe(false);
    expect(isAccessGateBody('<html><body>403 Forbidden</body></html>')).toBe(false);
    expect(isAccessGateBody('plain forbidden page')).toBe(false);
  });
});

describe('isAccessGateProbeResponse', () => {
  // opaqueredirect 拿不到 Location，同源 302 与 Access 登录域跳转无从区分；
  // 一律按被门挡住处理，误判由 sessionStorage 的每会话一次守卫兜住。
  test('opaqueredirect / error / 状态 0 都视为被门挡住', () => {
    expect(isAccessGateProbeResponse('opaqueredirect', 0)).toBe(true);
    expect(isAccessGateProbeResponse('error', 0)).toBe(true);
    expect(isAccessGateProbeResponse('basic', 0)).toBe(true);
  });

  test('正常响应（含业务 403/401）不算', () => {
    for (const status of [200, 401, 403, 500]) {
      expect(isAccessGateProbeResponse('basic', status)).toBe(false);
    }
  });
});

describe('probeAccessGate', () => {
  test('探到 302 跳转（Access 登录）→ 注销 + 刷新', async () => {
    const h = harness({ probe: async () => ({ type: 'opaqueredirect', status: 0 }) });
    expect(await probeAccessGate(h.deps)).toBe(true);
    expect(h.state.unregistered).toBe(1);
    expect(h.state.reloads).toBe(1);
  });

  test('正常响应不做任何处置', async () => {
    const h = harness();
    expect(await probeAccessGate(h.deps)).toBe(false);
    expect(h.state.reloads).toBe(0);
  });

  test('fetch 直接 reject（多半是离线）绝不注销 SW', async () => {
    const h = harness({ probe: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await probeAccessGate(h.deps)).toBe(false);
    expect(h.state.unregistered).toBe(0);
    expect(h.state.reloads).toBe(0);
  });

  test('未被 SW 控制时根本不探', async () => {
    const h = harness({ controlled: false });
    expect(await probeAccessGate(h.deps)).toBe(false);
    expect(h.state.probes).toBe(0);
  });

  test('与响应钩子共用 once 守卫，两条路径同时命中只刷一次', async () => {
    const h = harness({ probe: async () => ({ type: 'opaqueredirect', status: 0 }) });
    expect(await probeAccessGate(h.deps)).toBe(true);
    expect(await recoverFromAccessGate(h.deps)).toBe(false);
    expect(h.state.reloads).toBe(1);
  });
});

describe('installAccessGateGuards', () => {
  test('同时装上探测与观察者，返回的函数摘掉观察者', async () => {
    const h = harness();
    const remove = installAccessGateGuards(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.probes).toBe(1);
    expect(h.hooked()).toBe(true);
    remove();
    expect(h.hooked()).toBe(false);
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
