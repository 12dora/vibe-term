// 退避门（每 node REST 客户端）与 4401 之后那一次会话探测。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient, sessionProbeTimeoutMs } from '@vibeterm/api-client';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { createGatedNodeApiClient, probeNodeSession, SESSION_PROBE_TIMEOUT_MS } = await import(
  './node-session-probe'
);
const {
  clearNodeBackoff,
  isNodeRequestBlocked,
  noteNodeUnreachable,
  setNodeBackoffTimersForTest,
  NodeBackoffSkippedError,
} = await import('./node-unreachable-backoff');

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function stubFetch(handler: (call: FetchCall) => Promise<Response> | Response): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), ...(init ? { init } : {}) };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
}

/** 传输层失败：真实 fetch 是 reject 而不是同步抛。 */
function stubFetchRejecting(error: Error): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push({ url: String(input) });
    return Promise.reject(error);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let now = 0;

beforeEach(() => {
  calls = [];
  now = 1_000_000;
  setNodeBackoffTimersForTest({
    schedule: () => 1,
    cancel: () => undefined,
    now: () => now,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setNodeBackoffTimersForTest(null);
});

describe('createGatedNodeApiClient', () => {
  test('退避窗口里的 GET 就地短路，一个字节都不发', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    await expect(client.fetch('/api/devices')).rejects.toBeInstanceOf(NodeBackoffSkippedError);
    expect(calls).toHaveLength(0);
  });

  test('退避窗口里没有任何「隔一会儿自己放一发」的出口（那会把指数退避拉平成固定周期）', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    for (let i = 0; i < 5; i++) {
      now += 60_000;
      await client.fetch('/api/devices').catch(() => undefined);
    }
    expect(calls).toHaveLength(0);
  });

  test('clearNodeBackoff（重试按钮的钩子最终调的就是它）之后立刻放行', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);
    await client.fetch('/api/devices').catch(() => undefined);
    expect(calls).toHaveLength(0);

    clearNodeBackoff(NODE_A);
    await client.fetch('/api/devices');
    expect(calls).toHaveLength(1);
  });

  test('写操作照常放行（用户主动发起的动作不该被退避挡住）', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    const res = await client.fetch('/api/devices', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // 成功一次就把退避解除，界面立刻回到正常节奏。
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('路径带 `/n/<id>` 前缀，退避外照常发请求', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);

    await client.fetch('/api/devices');
    expect(calls[0]?.url).toBe(`/n/${NODE_A}/api/devices`);
  });

  test('传输层异常记一次打不通', async () => {
    stubFetchRejecting(new TypeError('Failed to fetch'));
    const client = createGatedNodeApiClient(NODE_A);

    await expect(client.fetch('/api/devices')).rejects.toBeInstanceOf(TypeError);
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
  });

  test('转发器的 503 不算「答上话了」，退避照旧生效', async () => {
    stubFetch(() => jsonResponse({ code: 'NODE_UNREACHABLE' }, 503));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    // 写请求穿过门拿到 503：不能把它当成恢复。
    await client.fetch('/api/devices', { method: 'POST' });
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
  });

  test('self 不设门', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient('self');
    expect(client.baseUrl).toBe('');
    await client.fetch('/api/devices');
    expect(calls[0]?.url).toBe('/api/devices');
  });
});

describe('probeNodeSession', () => {
  test('退避窗口里不发探测，直接报打不通', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    noteNodeUnreachable(NODE_A);

    expect(await probeNodeSession(NODE_A)).toBe('unreachable');
    expect(calls).toHaveLength(0);
  });

  test('拉到设备列表 = 会话有效，并解除退避', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    expect(await probeNodeSession(NODE_A)).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal).toBeDefined();
  });

  test('401 NODE_LOGIN_REQUIRED = 该 node 要重新登录（不进退避）', async () => {
    stubFetch(() => jsonResponse({ code: 'NODE_LOGIN_REQUIRED' }, 401));
    expect(await probeNodeSession(NODE_A)).toBe('login-required');
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('503 NODE_UNREACHABLE = 打不通，并记一次退避', async () => {
    stubFetch(() => jsonResponse({ code: 'NODE_UNREACHABLE' }, 503));
    expect(await probeNodeSession(NODE_A)).toBe('unreachable');
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
  });

  test('传输层异常同样按打不通处理', async () => {
    stubFetchRejecting(new TypeError('Failed to fetch'));
    expect(await probeNodeSession(NODE_A)).toBe('unreachable');
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
  });

  test('无 EWMA 时探测超时为 8s 下限', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const seen: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((ms: number) => {
      seen.push(ms);
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;
    try {
      expect(await probeNodeSession(NODE_A)).toBe('ok');
      expect(seen).toContain(SESSION_PROBE_TIMEOUT_MS);
      expect(sessionProbeTimeoutMs(null)).toBe(SESSION_PROBE_TIMEOUT_MS);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  test('高 RTT 时探测超时跟着 lastLatencyMs 放大', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const seen: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const originalLatency = ApiClient.prototype.lastLatencyMs;
    AbortSignal.timeout = ((ms: number) => {
      seen.push(ms);
      return originalTimeout(ms);
    }) as typeof AbortSignal.timeout;
    ApiClient.prototype.lastLatencyMs = () => 2_000;
    try {
      expect(await probeNodeSession(NODE_A)).toBe('ok');
      expect(seen).toContain(16_000);
    } finally {
      AbortSignal.timeout = originalTimeout;
      ApiClient.prototype.lastLatencyMs = originalLatency;
    }
  });
});
