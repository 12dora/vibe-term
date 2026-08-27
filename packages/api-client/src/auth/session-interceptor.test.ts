import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient, clearResponseHooks } from '../client';
import {
  type AuthRequiredDetail,
  configureSessionInterceptor,
  installSessionInterceptor,
  nodeIdFromPath,
  onAuthRequired,
  uninstallSessionInterceptor,
} from './session-interceptor';

const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const NODE_C = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function setup() {
  const events: AuthRequiredDetail[] = [];
  const navigated: string[] = [];
  const offEvent = onAuthRequired((detail) => events.push(detail));
  configureSessionInterceptor({
    navigate: (to) => navigated.push(to),
    currentLocation: () => '/devices/abc',
  });
  installSessionInterceptor();
  return { events, navigated, offEvent };
}

function clientReturning(res: () => Response, baseUrl = ''): ApiClient {
  return new ApiClient(baseUrl, () => Promise.resolve(res()));
}

// 钩子派发是 fire-and-forget 的（要 clone().json()），等一个微任务队列排空。
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  uninstallSessionInterceptor();
  clearResponseHooks();
  configureSessionInterceptor({ navigate: undefined, currentLocation: undefined });
});

describe('nodeIdFromPath', () => {
  test('无前缀路径为 self', () => {
    expect(nodeIdFromPath('/api/devices')).toBe('self');
    expect(nodeIdFromPath('/n')).toBe('self');
  });

  test('`/n/:id` 前缀取出规范 nodeId', () => {
    expect(nodeIdFromPath(`/n/${NODE_B}/api/devices`)).toBe(NODE_B);
    expect(nodeIdFromPath(`/n/${NODE_C}/api/x?q=1`)).toBe(NODE_C);
    expect(nodeIdFromPath(`/n/${NODE_C}`)).toBe(NODE_C);
  });

  test('不是规范 node id 的前缀按 self 处理', () => {
    expect(nodeIdFromPath('/n/node b/api/x')).toBe('self');
    expect(nodeIdFromPath('/n/../api/x')).toBe('self');
  });
});

describe('session interceptor', () => {
  test('全局 401 派发 global 事件并跳登录页带 next', async () => {
    const { events, navigated } = setup();
    const client = clientReturning(() => new Response('{}', { status: 401 }));
    await client.fetch('/api/devices');
    await flush();

    expect(events).toEqual([{ nodeId: 'self', scope: 'global', path: '/api/devices' }]);
    expect(navigated).toEqual(['/login?next=%2Fdevices%2Fabc']);
  });

  test('NODE_LOGIN_REQUIRED 只派发 node 事件，不跳转', async () => {
    const { events, navigated } = setup();
    const client = clientReturning(
      () =>
        new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_B }), {
          status: 401,
        })
    );
    await client.fetch(`/n/${NODE_B}/api/devices`);
    await flush();

    expect(events).toEqual([{ nodeId: NODE_B, scope: 'node', path: `/n/${NODE_B}/api/devices` }]);
    expect(navigated).toEqual([]);
  });

  test('转发路径上无 code 的 401 也按 node 处理，不跳转', async () => {
    const { events, navigated } = setup();
    const client = clientReturning(() => new Response('nope', { status: 401 }));
    await client.fetch(`/n/${NODE_C}/api/devices`);
    await flush();

    expect(events).toEqual([{ nodeId: NODE_C, scope: 'node', path: `/n/${NODE_C}/api/devices` }]);
    expect(navigated).toEqual([]);
  });

  test('node runtime 的相对路径 + baseUrl 前缀：401 归该 node，不把整页踢去登录页', async () => {
    const { events, navigated } = setup();
    // 每 node runtime 都是 `new ApiClient('/n/<id>')` 再 fetch('/api/devices')。
    const client = clientReturning(() => new Response('nope', { status: 401 }), `/n/${NODE_C}`);
    await client.fetch('/api/devices');
    await flush();

    expect(events).toEqual([{ nodeId: NODE_C, scope: 'node', path: `/n/${NODE_C}/api/devices` }]);
    expect(navigated).toEqual([]);
  });

  test('非 401 不派发也不跳转', async () => {
    const { events, navigated } = setup();
    const client = clientReturning(() => new Response('{}', { status: 200 }));
    await client.fetch('/api/devices');
    await flush();

    expect(events).toEqual([]);
    expect(navigated).toEqual([]);
  });

  test('钩子读 body 用 clone，调用方仍能读到原始 body', async () => {
    setup();
    const client = clientReturning(
      () =>
        new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_B }), {
          status: 401,
        })
    );
    const res = await client.fetch(`/n/${NODE_B}/api/devices`);
    const payload = (await res.json()) as { code: string };
    expect(payload.code).toBe('NODE_LOGIN_REQUIRED');
    await flush();
  });

  test('next 已在登录页时不再叠加 next 参数', async () => {
    const { navigated } = setup();
    configureSessionInterceptor({ currentLocation: () => '/login?next=%2Fx' });
    const client = clientReturning(() => new Response('{}', { status: 401 }));
    await client.fetch('/api/devices');
    await flush();
    expect(navigated).toEqual(['/login']);
  });

  test('未安装拦截器时 fetch 不受影响', async () => {
    clearResponseHooks();
    const client = clientReturning(() => new Response('{}', { status: 401 }));
    const res = await client.fetch('/api/devices');
    expect(res.status).toBe(401);
  });
});
