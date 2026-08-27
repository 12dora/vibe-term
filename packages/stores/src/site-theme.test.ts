import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { FeatureSet } from '@tmex/api-client';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from './test-utils';

installWindowStorage();

mock.module('i18next', () => {
  const changeLanguage = mock(() => Promise.resolve());
  return { default: { changeLanguage, t: (k: string) => k } };
});

const sendMock = mock(() => true);
const isReadyMock = mock(() => true);
const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => {
  return {
    ...wsActual,
    getBorshClient: () => ({ send: sendMock, isReady: isReadyMock }),
    buildSiteThemeUpdate: (theme: 'dark' | 'light') => ({
      kind: 99,
      payload: new Uint8Array([theme === 'light' ? 1 : 2]),
    }),
  };
});

const { useSiteStore, useUIStore } = await import('./default-runtime');

const TMEX_UI_KEY = 'tmex-ui';

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

function siteSettingsResponse(overrides: Partial<SiteSettings> = {}): typeof globalThis.fetch {
  return mock(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/settings/site')) {
      return new Response(JSON.stringify({ settings: makeSiteSettings(overrides) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

function readLocalStorageTheme(): 'dark' | 'light' | undefined {
  const raw = localStorage.getItem(TMEX_UI_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } };
    return parsed?.state?.theme === 'light' ? 'light' : 'dark';
  } catch {
    return undefined;
  }
}

describe('useSiteStore theme', () => {
  beforeEach(() => {
    localStorage.clear();
    sendMock.mockClear();
    isReadyMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    useSiteStore.setState({ settings: null, loading: false });
    useUIStore.setState({ theme: 'dark' });
  });

  test('fetchSettings 失败时回落到 DEFAULT_SETTINGS，theme 为 dark', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof globalThis.fetch;

    try {
      useUIStore.setState({ theme: 'light' });
      const settings = await useSiteStore.getState().fetchSettings();

      expect(settings.theme).toBe('dark');
      expect(useSiteStore.getState().settings?.theme).toBe('dark');
      expect(useUIStore.getState().theme).toBe('dark');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchSettings 从 /api/settings/site 加载 theme', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = siteSettingsResponse({ theme: 'light' });

    try {
      const settings = await useSiteStore.getState().fetchSettings();
      expect(settings.theme).toBe('light');
      expect(useUIStore.getState().theme).toBe('light');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('updateTheme 乐观更新本地 state + 发 C2S', () => {
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(useSiteStore.getState().settings?.theme).toBe('light');
    expect(useUIStore.getState().theme).toBe('light');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('updateTheme 同时写 localStorage 作为离线 fallback', () => {
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(readLocalStorageTheme()).toBe('light');
  });

  test('离线场景：ws 未就绪时 updateTheme 只写 localStorage + 本地 state，不发 C2S', () => {
    isReadyMock.mockImplementation(() => false);
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(readLocalStorageTheme()).toBe('light');
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('setThemeFromS2C 更新本地 state 但不回送 C2S', () => {
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().setThemeFromS2C('light');

    expect(useSiteStore.getState().settings?.theme).toBe('light');
    expect(useUIStore.getState().theme).toBe('light');
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('useUIStore.theme 从 useSiteStore.theme 派生（fetchSettings 后同步）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = siteSettingsResponse({ theme: 'dark' });

    try {
      useUIStore.setState({ theme: 'light' });
      await useSiteStore.getState().fetchSettings();
      expect(useUIStore.getState().theme).toBe('dark');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('useUIStore.setTheme 保留本地 state 更新（persist 写 localStorage）', () => {
    useUIStore.setState({ theme: 'dark' });

    useUIStore.getState().setTheme('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(readLocalStorageTheme()).toBe('light');
  });
});

describe('useSiteStore capabilities', () => {
  test('loadCapabilities 从 /api/capabilities 填充 FeatureSet', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/capabilities')) {
        return new Response(
          JSON.stringify({
            serverImpl: 'tmex',
            serverVersion: '0.0.0',
            apiVersion: 1,
            wsProtocolVersion: 1,
            capabilities: ['tmex-ws-borsh-v1', 'tmex-agent-v1'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await useSiteStore.getState().loadCapabilities();
      const caps = useSiteStore.getState().capabilities;
      expect(caps.has('tmex-agent-v1')).toBe(true);
      expect(caps.has('missing-cap')).toBe(false);
      expect(caps.list().sort()).toEqual(['tmex-agent-v1', 'tmex-ws-borsh-v1']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('loadCapabilities 请求失败时静默保持空集（不抛）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response('nope', { status: 500 })
    ) as unknown as typeof fetch;
    try {
      useSiteStore.setState({ capabilities: FeatureSet.empty() });
      await useSiteStore.getState().loadCapabilities();
      expect(useSiteStore.getState().capabilities.list()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
