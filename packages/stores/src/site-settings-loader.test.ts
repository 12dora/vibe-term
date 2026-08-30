import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import { type SiteSettingsLoader, createSiteSettingsLoader } from './site-settings-loader';

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
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const FALLBACK = makeSiteSettings({ siteName: 'fallback' });

interface Deferred {
  resolve: (settings: SiteSettings) => void;
  reject: (err: unknown) => void;
}

interface Harness {
  loader: SiteSettingsLoader;
  pending: Deferred[];
  commits: SiteSettings[];
  loadings: boolean[];
  current: () => SiteSettings | null;
}

function createHarness(): Harness {
  const pending: Deferred[] = [];
  const commits: SiteSettings[] = [];
  const loadings: boolean[] = [];
  let settings: SiteSettings | null = null;

  const loader = createSiteSettingsLoader({
    request: () =>
      new Promise<SiteSettings>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    current: () => settings,
    setLoading: (loading) => loadings.push(loading),
    commit: (next) => {
      settings = next;
      commits.push(next);
    },
    fallback: FALLBACK,
  });

  return { loader, pending, commits, loadings, current: () => settings };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let originalConsoleError: typeof console.error;

beforeEach(() => {
  // 失败路径按设计会打日志，避免污染测试输出（同进程其它测试文件仍要用真的 console.error）
  originalConsoleError = console.error;
  console.error = mock(() => {});
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe('createSiteSettingsLoader 代次与在途共享', () => {
  test('invalidate 之后的搭车方另起请求，旧响应回来不落库', async () => {
    const h = createHarness();
    const stale = h.loader.ensureFreshSettings();
    expect(h.pending).toHaveLength(1);

    // 本地主题变更：在途响应带的是变更前的外观
    h.loader.invalidate();

    const fresh = h.loader.ensureFreshSettings();
    expect(h.pending).toHaveLength(2);

    h.pending[1]?.resolve(makeSiteSettings({ siteName: 'fresh', theme: 'light' }));
    await expect(fresh).resolves.toMatchObject({ siteName: 'fresh' });
    expect(h.current()?.siteName).toBe('fresh');

    h.pending[0]?.resolve(makeSiteSettings({ siteName: 'stale', theme: 'dark' }));
    await expect(stale).resolves.toMatchObject({ siteName: 'fresh' });
    expect(h.current()?.siteName).toBe('fresh');
    expect(h.commits).toHaveLength(1);
  });

  test('invalidate 后在途请求先返回也不落库，且不抢占后续提交', async () => {
    const h = createHarness();
    const stale = h.loader.ensureFreshSettings();
    h.loader.invalidate();
    const fresh = h.loader.ensureFreshSettings();

    h.pending[0]?.resolve(makeSiteSettings({ siteName: 'stale' }));
    await stale;
    expect(h.commits).toHaveLength(0);
    expect(h.current()).toBeNull();

    h.pending[1]?.resolve(makeSiteSettings({ siteName: 'fresh' }));
    await expect(fresh).resolves.toMatchObject({ siteName: 'fresh' });
    expect(h.current()?.siteName).toBe('fresh');
  });

  test('搭车方不抢代次：单次请求的结果照常落库', async () => {
    const h = createHarness();
    const boot = h.loader.fetchSettings();
    const form = h.loader.ensureFreshSettings();
    const third = h.loader.fetchSettings();
    expect(h.pending).toHaveLength(1);

    h.pending[0]?.resolve(makeSiteSettings({ siteName: 'shared' }));
    await expect(boot).resolves.toMatchObject({ siteName: 'shared' });
    await expect(form).resolves.toMatchObject({ siteName: 'shared' });
    await expect(third).resolves.toMatchObject({ siteName: 'shared' });
    expect(h.commits).toHaveLength(1);
    expect(h.current()?.siteName).toBe('shared');
  });

  test('保存后的重拉不会被保存前的在途响应盖掉', async () => {
    const h = createHarness();
    const beforeSave = h.loader.fetchSettings();
    // PATCH 成功 → refreshSettings 一定另起一次
    const afterSave = h.loader.refreshSettings();
    expect(h.pending).toHaveLength(2);

    h.pending[1]?.resolve(makeSiteSettings({ siteName: 'after-save', theme: 'light' }));
    await expect(afterSave).resolves.toMatchObject({ siteName: 'after-save' });

    h.pending[0]?.resolve(makeSiteSettings({ siteName: 'before-save', theme: 'dark' }));
    await beforeSave;
    expect(h.current()).toMatchObject({ siteName: 'after-save', theme: 'light' });
    expect(h.commits).toHaveLength(1);
  });
});

describe('createSiteSettingsLoader 失败处理', () => {
  test('多个搭车方同时失败：兜底值只提交一次，各方拿到同一份', async () => {
    const h = createHarness();
    const first = h.loader.fetchSettings();
    const second = h.loader.fetchSettings();
    expect(h.pending).toHaveLength(1);

    h.pending[0]?.reject(new Error('boom'));
    const [a, b] = await Promise.all([first, second]);
    expect(a.siteName).toBe('fallback');
    expect(b).toBe(a);
    expect(h.current()?.siteName).toBe('fallback');
    expect(h.commits).toHaveLength(1);
  });

  test('fetch 与 ensureFresh 混合搭车失败时行为一致：前者兜底、后者抛出', async () => {
    const h = createHarness();
    const boot = h.loader.fetchSettings();
    const form = h.loader.ensureFreshSettings();
    expect(h.pending).toHaveLength(1);

    h.pending[0]?.reject(new Error('boom'));
    await expect(form).rejects.toThrow('boom');
    await expect(boot).resolves.toMatchObject({ siteName: 'fallback' });
    expect(h.loadings.at(-1)).toBe(false);
  });

  test('失败之后的下一次取数照常发新请求并落库', async () => {
    const h = createHarness();
    const failed = h.loader.ensureFreshSettings();
    h.pending[0]?.reject(new Error('boom'));
    await expect(failed).rejects.toThrow('boom');
    await flushAsync();

    const retry = h.loader.ensureFreshSettings();
    expect(h.pending).toHaveLength(2);
    h.pending[1]?.resolve(makeSiteSettings({ siteName: 'recovered' }));
    await expect(retry).resolves.toMatchObject({ siteName: 'recovered' });
    expect(h.current()?.siteName).toBe('recovered');
  });

  test('旧请求失败时不复位 loading：新请求还在途', async () => {
    const h = createHarness();
    const stale = h.loader.refreshSettings();
    const fresh = h.loader.refreshSettings();

    h.pending[0]?.reject(new Error('boom'));
    await expect(stale).rejects.toThrow('boom');
    expect(h.loadings).toEqual([true, true]);

    h.pending[1]?.resolve(makeSiteSettings({ siteName: 'fresh' }));
    await expect(fresh).resolves.toMatchObject({ siteName: 'fresh' });
  });
});
