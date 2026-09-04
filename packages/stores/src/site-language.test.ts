// 全局 i18n 语言只能由宿主 / self 的 runtime 驱动：i18next 是浏览器级单例，
// 远端 node 的站点设置（常常还是 en_US）一旦写进去，整页 UI 就会在进入
// `/n/<id>/...` 子树时被掀翻（见 f4 任务 B）。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const changeLanguage = mock((_lng: string) => Promise.resolve());
// 可变桩：site.ts 的失败兜底会读 resolvedLanguage/language 决定「保持当前语言」
const i18nextStub: {
  changeLanguage: typeof changeLanguage;
  t: (key: string) => string;
  resolvedLanguage?: string;
  language?: string;
} = { changeLanguage, t: (key: string) => key };
mock.module('i18next', () => ({ default: i18nextStub }));

const { createAppRuntime } = await import('./app-runtime');
const { SITE_LANGUAGE_CACHE_KEY } = await import('./site-language-cache');

const SETTINGS: SiteSettings = {
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
  language: 'zh_CN',
  disabledNotificationChannels: [],
  theme: 'dark',
  updatedAt: new Date().toISOString(),
};

let originalFetch: typeof globalThis.fetch;
let originalConsoleError: typeof console.error;
let restoreDocument: (() => void) | null = null;
let runtimeIndex = 0;

// syncThemeToUIStore 读 documentElement.classList；同进程其它测试可能留下不完整的 document 桩。
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

function makeRuntime(controlsBrowserPrefs?: boolean) {
  runtimeIndex += 1;
  return createAppRuntime({
    storagePrefix: `site-language-${runtimeIndex}-`,
    ...(controlsBrowserPrefs === undefined ? {} : { controlsBrowserPrefs }),
  });
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSiteStore controlsBrowserPrefs', () => {
  beforeEach(() => {
    changeLanguage.mockClear();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock((url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url.toString();
      if (!target.includes('/api/settings/site')) {
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ settings: SETTINGS }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as unknown as typeof globalThis.fetch;
    installDocumentStub();
    localStorage.removeItem(SITE_LANGUAGE_CACHE_KEY);
    i18nextStub.resolvedLanguage = undefined;
    i18nextStub.language = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreDocument?.();
    restoreDocument = null;
  });

  test('缺省（宿主 runtime）仍把站点语言写进全局 i18next', async () => {
    const runtime = makeRuntime();
    await runtime.stores.site.getState().fetchSettings();
    expect(changeLanguage).toHaveBeenCalledWith('zh_CN');
  });

  test('远端 node 的 runtime 拉取站点设置不改全局语言，但自己的 store 照常落库', async () => {
    const runtime = makeRuntime(false);
    const settings = await runtime.stores.site.getState().fetchSettings();

    expect(changeLanguage).not.toHaveBeenCalled();
    expect(settings.language).toBe('zh_CN');
    expect(runtime.stores.site.getState().settings?.language).toBe('zh_CN');
  });

  test('refreshSettings 与 site 设置变更事件同样不改全局语言', async () => {
    const runtime = makeRuntime(false);
    await runtime.stores.site.getState().refreshSettings();
    expect(changeLanguage).not.toHaveBeenCalled();

    runtime.stores.site.getState().handleSettingsUpdate('site');
    await flushAsync();
    expect(runtime.stores.site.getState().settings?.language).toBe('zh_CN');
    expect(changeLanguage).not.toHaveBeenCalled();
  });

  test('宿主 runtime 成功取数后把语言写进浏览器级缓存', async () => {
    const runtime = makeRuntime();
    await runtime.stores.site.getState().fetchSettings();
    expect(localStorage.getItem(SITE_LANGUAGE_CACHE_KEY)).toBe('zh_CN');
  });

  test('远端 node 的 runtime 不写浏览器级语言缓存', async () => {
    const runtime = makeRuntime(false);
    await runtime.stores.site.getState().fetchSettings();
    expect(localStorage.getItem(SITE_LANGUAGE_CACHE_KEY)).toBeNull();
  });
});

// 取数失败（401 未登录 / 网络抖动 / 中继抖动）走兜底提交，此前它会把 DEFAULT_SETTINGS.language
// （en_US）落进 store 并切 i18next，等于主动把中文界面掀成英文，直到设置页某次请求成功。
describe('createSiteStore 取数失败不降级语言', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Unauthorized', { status: 401 }))
    ) as unknown as typeof globalThis.fetch;
    installDocumentStub();
    localStorage.removeItem(SITE_LANGUAGE_CACHE_KEY);
    changeLanguage.mockClear();
    i18nextStub.resolvedLanguage = undefined;
    i18nextStub.language = undefined;
    originalConsoleError = console.error;
    console.error = mock(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreDocument?.();
    restoreDocument = null;
  });

  test('失败兜底不调用 changeLanguage', async () => {
    const runtime = makeRuntime();
    await runtime.stores.site.getState().fetchSettings();
    expect(changeLanguage).not.toHaveBeenCalled();
  });

  test('失败兜底沿用缓存里的站点语言，而不是 en_US 默认值', async () => {
    localStorage.setItem(SITE_LANGUAGE_CACHE_KEY, 'zh_CN');
    const runtime = makeRuntime();
    const settings = await runtime.stores.site.getState().fetchSettings();

    expect(settings.language).toBe('zh_CN');
    expect(runtime.stores.site.getState().settings?.language).toBe('zh_CN');
  });

  test('无缓存时沿用 i18next 当前语言', async () => {
    i18nextStub.resolvedLanguage = 'ja_JP';
    const runtime = makeRuntime();
    const settings = await runtime.stores.site.getState().fetchSettings();

    expect(settings.language).toBe('ja_JP');
  });

  test('缓存与当前语言都拿不到才落 en_US，且非语言默认值照常补齐', async () => {
    const runtime = makeRuntime();
    const settings = await runtime.stores.site.getState().fetchSettings();

    expect(settings.language).toBe('en_US');
    expect(settings.theme).toBe('dark');
    expect(runtime.stores.site.getState().loading).toBe(false);
  });

  test('远端 node 的 runtime 失败兜底不读浏览器级缓存', async () => {
    localStorage.setItem(SITE_LANGUAGE_CACHE_KEY, 'zh_CN');
    const runtime = makeRuntime(false);
    const settings = await runtime.stores.site.getState().fetchSettings();

    expect(settings.language).toBe('en_US');
    expect(changeLanguage).not.toHaveBeenCalled();
  });
});
