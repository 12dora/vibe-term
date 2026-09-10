// 退避门（每 node REST 客户端）与 4401 之后那一次会话探测。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const {
  GATE_CANARY_INTERVAL_MS,
  MANUAL_READ_HEADER,
  createGatedNodeApiClient,
  manualRead,
  probeNodeSession,
  setGateClockForTest,
} = await import('./node-session-probe');
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
  setGateClockForTest(() => now);
  setNodeBackoffTimersForTest({
    schedule: () => 1,
    cancel: () => undefined,
    now: () => now,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setNodeBackoffTimersForTest(null);
  setGateClockForTest(null);
});

describe('createGatedNodeApiClient', () => {
  test('退避窗口里的 GET 就地短路，一个字节都不发（探路名额已用掉）', async () => {
    stubFetch(() => jsonResponse({ code: 'NODE_UNREACHABLE' }, 503));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    // 第一发是探路名额，会真的出去；第二发才被短路。
    await client.fetch('/api/devices');
    expect(calls).toHaveLength(1);
    await expect(client.fetch('/api/devices')).rejects.toBeInstanceOf(NodeBackoffSkippedError);
    expect(calls).toHaveLength(1);
  });

  test('打了「用户点的」标记的读一律放行，且标记不会被发出去', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);
    // 先把探路名额用掉，确认放行是标记的功劳。
    await client.fetch('/api/devices').catch(() => undefined);
    calls = [];

    const res = await client.fetch('/api/devices', manualRead());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init?.headers).has(MANUAL_READ_HEADER)).toBe(false);
    // 成功即解除退避，之后一切照常。
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('探路名额每 20 秒回一发：没打标记的重试最多等这一档', async () => {
    stubFetch(() => jsonResponse({ code: 'NODE_UNREACHABLE' }, 503));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);

    await client.fetch('/api/devices');
    await expect(client.fetch('/api/devices')).rejects.toBeInstanceOf(NodeBackoffSkippedError);
    now += GATE_CANARY_INTERVAL_MS;
    await client.fetch('/api/devices');
    expect(calls).toHaveLength(2);
  });

  test('clearNodeBackoff 之后立刻恢复正常', async () => {
    stubFetch(() => jsonResponse({ devices: [] }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);
    await client.fetch('/api/devices').catch(() => undefined);
    calls = [];

    clearNodeBackoff(NODE_A);
    await client.fetch('/api/devices');
    expect(calls).toHaveLength(1);
  });

  test('写操作照常放行（用户主动发起的动作不该被退避挡住）', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const client = createGatedNodeApiClient(NODE_A);
    noteNodeUnreachable(NODE_A);
    // 探路名额只管读，写请求不领也不消耗它。

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
});
