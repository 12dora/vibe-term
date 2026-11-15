import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient, clearResponseHooks, setRequestPopProvider } from '../client';
import {
  type AuthRequiredDetail,
  configureSessionInterceptor,
  installSessionInterceptor,
  onAuthRequired,
  uninstallSessionInterceptor,
} from './session-interceptor';

const NODE = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

function setup(canSign: boolean) {
  const events: AuthRequiredDetail[] = [];
  const navigated: string[] = [];
  const off = onAuthRequired((detail) => events.push(detail));
  configureSessionInterceptor({
    navigate: (to) => navigated.push(to),
    currentLocation: () => '/devices/abc',
  });
  installSessionInterceptor();
  setRequestPopProvider({ sign: () => null, canSign: () => canSign });
  return { events, navigated, off };
}

function popClient(code: string, baseUrl = ''): ApiClient {
  return new ApiClient(baseUrl, () =>
    Promise.resolve(new Response(JSON.stringify({ code }), { status: 401 }))
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  uninstallSessionInterceptor();
  clearResponseHooks();
  setRequestPopProvider(null);
  configureSessionInterceptor({ navigate: undefined, currentLocation: undefined });
});

describe('POP 类 401 的会话拦截', () => {
  test('钥还能签：既不派发事件也不跳登录页（错误交给调用方）', async () => {
    const { events, navigated, off } = setup(true);
    await popClient('POP_INVALID').fetch('/api/devices');
    await popClient('POP_REQUIRED', `/n/${NODE}`).fetch('/api/devices');
    await flush();
    off();
    expect(events).toEqual([]);
    expect(navigated).toEqual([]);
  });

  test('钥没了：self 与会话过期同义，跳登录页', async () => {
    const { events, navigated, off } = setup(false);
    await popClient('POP_REQUIRED').fetch('/api/devices');
    await flush();
    off();
    expect(events).toEqual([{ nodeId: 'self', scope: 'global', path: '/api/devices' }]);
    expect(navigated).toEqual(['/login?next=%2Fdevices%2Fabc']);
  });

  test('钥没了：转发 node 只派发该 node 的登录事件，不踢整页', async () => {
    const { events, navigated, off } = setup(false);
    await popClient('POP_INVALID', `/n/${NODE}`).fetch('/api/devices');
    await flush();
    off();
    expect(events).toEqual([{ nodeId: NODE, scope: 'node', path: `/n/${NODE}/api/devices` }]);
    expect(navigated).toEqual([]);
  });

  test('没有注册提供方：POP 码按普通 401 处理', async () => {
    const { events, off } = setup(true);
    setRequestPopProvider(null);
    await popClient('POP_INVALID').fetch('/api/devices');
    await flush();
    off();
    expect(events).toHaveLength(1);
  });
});
