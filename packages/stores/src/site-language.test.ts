// 全局 i18n 语言只能由宿主 / self 的 runtime 驱动：i18next 是浏览器级单例，
// 远端 node 的站点设置（常常还是 en_US）一旦写进去，整页 UI 就会在进入
// `/n/<id>/...` 子树时被掀翻（见 f4 任务 B）。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const changeLanguage = mock((_lng: string) => Promise.resolve());
mock.module('i18next', () => ({ default: { changeLanguage, t: (k: string) => k } }));

const { createAppRuntime } = await import('./app-runtime');

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
});
