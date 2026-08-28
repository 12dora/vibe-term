import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { FeatureSet } from '@tmex/api-client';
import type { SiteSettings } from '@tmex/shared';
import { THEME_PRESETS, THEME_PRESET_META, type ThemePreset } from '@tmex/theme';
import { installWindowStorage } from './test-utils';

// 预设名单会随版本增删；按 appearance 现取，避免写死 id
function presetWithAppearance(appearance: 'light' | 'dark'): ThemePreset {
  const found = THEME_PRESETS.find((id) => THEME_PRESET_META[id].appearance === appearance);
  if (!found) {
    throw new Error(`no ${appearance} theme preset registered`);
  }
  return found;
}

const DARK_PRESET = presetWithAppearance('dark');
const LIGHT_PRESET = presetWithAppearance('light');

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

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    useUIStore.setState({ theme: 'dark', themePreset: null });
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

describe('useSiteStore theme preset', () => {
  beforeEach(() => {
    localStorage.clear();
    sendMock.mockClear();
    isReadyMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    useSiteStore.setState({ settings: null, loading: false });
    useUIStore.setState({ theme: 'dark', themePreset: null });
  });

  test('selectThemePreset 落预设并把站点外观同步成预设自带的外观', () => {
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });

    useSiteStore.getState().selectThemePreset(LIGHT_PRESET);

    expect(useUIStore.getState().themePreset).toBe(LIGHT_PRESET);
    expect(useUIStore.getState().theme).toBe('light');
    expect(useSiteStore.getState().settings?.theme).toBe('light');
    // 外观是站点级设置，预设切换同样要上行
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('外观一致的预设切换不会把自己清掉', () => {
    useUIStore.setState({ theme: 'dark', themePreset: null });

    useSiteStore.getState().selectThemePreset(DARK_PRESET);

    expect(useUIStore.getState().themePreset).toBe(DARK_PRESET);
    expect(useUIStore.getState().theme).toBe('dark');
  });

  test('selectThemePreset(null, appearance) 清预设并落到指定外观', () => {
    useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });

    useSiteStore.getState().selectThemePreset(null, 'light');

    expect(useUIStore.getState().themePreset).toBeNull();
    expect(useUIStore.getState().theme).toBe('light');
  });

  test('selectThemePreset(null) 不带 fallback 时保持当前外观', () => {
    useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });

    useSiteStore.getState().selectThemePreset(null);

    expect(useUIStore.getState().themePreset).toBeNull();
    expect(useUIStore.getState().theme).toBe('dark');
  });

  test('setThemeFromS2C 外观与当前预设不符时清掉预设', () => {
    useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });

    useSiteStore.getState().setThemeFromS2C('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(useUIStore.getState().themePreset).toBeNull();
  });

  test('setThemeFromS2C 外观与预设一致时保留预设', () => {
    useUIStore.setState({ theme: 'light', themePreset: DARK_PRESET });

    useSiteStore.getState().setThemeFromS2C('dark');

    expect(useUIStore.getState().themePreset).toBe(DARK_PRESET);
  });

  test('直接 updateTheme 切到另一套外观时清掉预设', () => {
    useSiteStore.setState({ settings: makeSiteSettings({ theme: 'dark' }) });
    useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });

    useSiteStore.getState().updateTheme('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(useUIStore.getState().themePreset).toBeNull();
  });

  test('在途 fetchSettings 的旧 theme 不覆盖期间选中的预设', async () => {
    const originalFetch = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = siteSettingsResponse({ theme: 'dark' });
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      await gate;
      return respond(url);
    }) as unknown as typeof globalThis.fetch;

    try {
      useUIStore.setState({ theme: 'dark', themePreset: null });
      const pending = useSiteStore.getState().fetchSettings();

      useSiteStore.getState().selectThemePreset(LIGHT_PRESET);
      release();
      const settings = await pending;

      expect(settings.theme).toBe('light');
      expect(useSiteStore.getState().settings?.theme).toBe('light');
      expect(useSiteStore.getState().loading).toBe(false);
      expect(useUIStore.getState().theme).toBe('light');
      expect(useUIStore.getState().themePreset).toBe(LIGHT_PRESET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('S2C 失配清理前先同步另一标签页写入的预设', () => {
    // 另一标签页选了浅色预设并写进共享 localStorage，本页内存 store 还停在旧的深色预设；
    // 若按内存值判定，随后到达的 light S2C 会把对方刚选的预设清成 null 并回写。
    useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });
    localStorage.setItem(
      TMEX_UI_KEY,
      JSON.stringify({ state: { theme: 'light', themePreset: LIGHT_PRESET }, version: 0 })
    );

    useSiteStore.getState().setThemeFromS2C('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(useUIStore.getState().themePreset).toBe(LIGHT_PRESET);
  });

  test('fetchSettings 拿到的外观与预设不符时清掉预设', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = siteSettingsResponse({ theme: 'light' });

    try {
      useUIStore.setState({ theme: 'dark', themePreset: DARK_PRESET });
      await useSiteStore.getState().fetchSettings();

      expect(useUIStore.getState().theme).toBe('light');
      expect(useUIStore.getState().themePreset).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('useSiteStore handleSettingsUpdate', () => {
  beforeEach(() => {
    useSiteStore.setState({ settings: null, loading: false });
  });

  test("namespace 'site' 重新拉取设置并覆盖本地缓存", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = siteSettingsResponse({ siteName: 'renamed' });
    globalThis.fetch = fetchMock;

    try {
      useSiteStore.setState({ settings: makeSiteSettings({ siteName: 'stale' }) });

      useSiteStore.getState().handleSettingsUpdate('site');
      await flushAsync();

      expect(useSiteStore.getState().settings?.siteName).toBe('renamed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('其它 namespace 不触发 REST 重拉', () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = siteSettingsResponse();
    globalThis.fetch = fetchMock;

    try {
      for (const namespace of ['theme', 'llm', 'webhooks', 'tree-order']) {
        useSiteStore.getState().handleSettingsUpdate(namespace);
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expect(useSiteStore.getState().loading).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('重拉失败时静默保留旧缓存，不抛未处理拒绝', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof globalThis.fetch;

    try {
      useSiteStore.setState({ settings: makeSiteSettings({ siteName: 'kept' }) });

      useSiteStore.getState().handleSettingsUpdate('site');
      await flushAsync();

      expect(useSiteStore.getState().settings?.siteName).toBe('kept');
      expect(useSiteStore.getState().loading).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
