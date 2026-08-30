import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from './test-utils';

installWindowStorage();

mock.module('i18next', () => {
  const changeLanguage = mock(() => Promise.resolve());
  return { default: { changeLanguage, t: (k: string) => k } };
});

const { useSiteStore, useUIStore } = await import('./default-runtime');

function makeSiteSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'http://localhost',
    bellThrottleSeconds: 6,
    notificationThrottleSeconds: 3,
    enableBrowserNotificationToast: true,
    enableNotificationPush: true,
    enableBellPush: true,
    enableBellSound: true,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 10,
    language: 'en_US',
    disabledNotificationChannels: [],
    theme: 'dark',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type SettleSettings = (settings: SiteSettings) => void;

let originalFetch: typeof globalThis.fetch;
let restoreDocument: (() => void) | null = null;
let pending: SettleSettings[] = [];

// 同进程的其它测试文件会留下只带 visibilityState 的 document 桩，
// syncThemeToUIStore 读 documentElement.classList，这里自带一份完整桩并在用例后还原
function installDocumentStub(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: { classList: { toggle: () => {} } } },
    configurable: true,
    writable: true,
  });
  restoreDocument = () => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  };
}

function installDeferredFetch(): void {
  pending = [];
  globalThis.fetch = mock((url: string | URL | Request) => {
    const target = typeof url === 'string' ? url : url.toString();
    if (!target.includes('/api/settings/site')) {
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    }
    return new Promise<Response>((resolve) => {
      pending.push((settings) => {
        resolve(
          new Response(JSON.stringify({ settings }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      });
    });
  }) as unknown as typeof globalThis.fetch;
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('useSiteStore refreshSettings 并发', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installDeferredFetch();
    installDocumentStub();
    useSiteStore.setState({ settings: null, loading: false });
    useUIStore.setState({ theme: 'dark' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreDocument?.();
    restoreDocument = null;
  });

  test('两次重拉乱序返回时，只有最新一次提交（旧响应后到也不回滚）', async () => {
    const store = useSiteStore.getState();
    const first = store.refreshSettings();
    const second = store.refreshSettings();
    expect(pending).toHaveLength(2);

    // 新的先回来
    pending[1]?.(makeSiteSettings({ siteName: 'newest', theme: 'light', language: 'zh_CN' }));
    await second;
    expect(useSiteStore.getState().settings?.siteName).toBe('newest');

    // 旧的后到：不得覆盖 settings / theme
    pending[0]?.(makeSiteSettings({ siteName: 'stale', theme: 'dark', language: 'en_US' }));
    await first;

    const state = useSiteStore.getState();
    expect(state.settings?.siteName).toBe('newest');
    expect(state.settings?.theme).toBe('light');
    expect(state.settings?.language).toBe('zh_CN');
    expect(useUIStore.getState().theme).toBe('light');
    expect(state.loading).toBe(false);
  });

  test('旧重拉返回过期数据时，返回值也是最新提交的设置', async () => {
    const store = useSiteStore.getState();
    const first = store.refreshSettings();
    store.refreshSettings();

    pending[1]?.(makeSiteSettings({ siteName: 'newest' }));
    await flushAsync();
    pending[0]?.(makeSiteSettings({ siteName: 'stale' }));

    await expect(first).resolves.toMatchObject({ siteName: 'newest' });
  });

  test('落后的重拉先返回时不落库，也不把 loading 提前置回 false', async () => {
    const store = useSiteStore.getState();
    const first = store.refreshSettings();
    store.refreshSettings();

    // 旧请求先回：第二次仍在途，store 不得提交
    pending[0]?.(makeSiteSettings({ siteName: 'stale' }));
    await first;
    expect(useSiteStore.getState().loading).toBe(true);
    expect(useSiteStore.getState().settings).toBeNull();

    pending[1]?.(makeSiteSettings({ siteName: 'newest' }));
    await flushAsync();
    expect(useSiteStore.getState().loading).toBe(false);
    expect(useSiteStore.getState().settings?.siteName).toBe('newest');
  });

  test('handleSettingsUpdate 连续触发时以最后一次响应为准', async () => {
    useSiteStore.setState({ settings: makeSiteSettings({ siteName: 'stale' }) });

    useSiteStore.getState().handleSettingsUpdate('site');
    useSiteStore.getState().handleSettingsUpdate('site');
    expect(pending).toHaveLength(2);

    pending[1]?.(makeSiteSettings({ siteName: 'newest' }));
    await flushAsync();
    pending[0]?.(makeSiteSettings({ siteName: 'even-older' }));
    await flushAsync();

    expect(useSiteStore.getState().settings?.siteName).toBe('newest');
    expect(useSiteStore.getState().loading).toBe(false);
  });
});

// 侧栏引导与设置页表单会同时要站点设置：在途的那次 GET 共享给所有等待方，
// 但保存 / 失效信号之后的重拉必须另起一次（搭车会拿回变更之前的数据）。
describe('useSiteStore 站点设置取数的共享', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installDeferredFetch();
    installDocumentStub();
    useSiteStore.setState({ settings: null, loading: false });
    useUIStore.setState({ theme: 'dark' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreDocument?.();
    restoreDocument = null;
  });

  test('并发的 fetchSettings 只发一次请求', async () => {
    const first = useSiteStore.getState().fetchSettings();
    const second = useSiteStore.getState().fetchSettings();
    expect(pending).toHaveLength(1);

    pending[0]?.(makeSiteSettings({ siteName: 'shared' }));
    await expect(first).resolves.toMatchObject({ siteName: 'shared' });
    await expect(second).resolves.toMatchObject({ siteName: 'shared' });
    expect(useSiteStore.getState().settings?.siteName).toBe('shared');
  });

  test('ensureFreshSettings 搭在途请求的车：引导与设置表单只出一次 GET', async () => {
    const boot = useSiteStore.getState().fetchSettings();
    const form = useSiteStore.getState().ensureFreshSettings();
    expect(pending).toHaveLength(1);

    pending[0]?.(makeSiteSettings({ siteName: 'shared' }));
    await expect(form).resolves.toMatchObject({ siteName: 'shared' });
    await boot;
  });

  test('ensureFreshSettings 不吃缓存：已有设置也照样重拉', async () => {
    useSiteStore.setState({ settings: makeSiteSettings({ siteName: 'cached' }) });

    const fresh = useSiteStore.getState().ensureFreshSettings();
    expect(pending).toHaveLength(1);
    pending[0]?.(makeSiteSettings({ siteName: 'fresh' }));
    await expect(fresh).resolves.toMatchObject({ siteName: 'fresh' });
    expect(useSiteStore.getState().settings?.siteName).toBe('fresh');
  });

  test('refreshSettings 不搭在途请求的车：保存后必须拿到变更之后的数据', async () => {
    const boot = useSiteStore.getState().fetchSettings();
    const afterSave = useSiteStore.getState().refreshSettings();
    expect(pending).toHaveLength(2);

    pending[0]?.(makeSiteSettings({ siteName: 'before-save' }));
    pending[1]?.(makeSiteSettings({ siteName: 'after-save' }));
    await expect(afterSave).resolves.toMatchObject({ siteName: 'after-save' });
    await boot;
    expect(useSiteStore.getState().settings?.siteName).toBe('after-save');
  });

  test('在途请求结束后不再被复用', async () => {
    const first = useSiteStore.getState().ensureFreshSettings();
    pending[0]?.(makeSiteSettings({ siteName: 'first' }));
    await first;

    const second = useSiteStore.getState().ensureFreshSettings();
    expect(pending).toHaveLength(2);
    pending[1]?.(makeSiteSettings({ siteName: 'second' }));
    await expect(second).resolves.toMatchObject({ siteName: 'second' });
  });
});
