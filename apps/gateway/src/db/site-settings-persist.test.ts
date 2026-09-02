import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '.';
import { setSiteSettingsLinkProvider } from '../api/site-settings-link';
import { getDb as getOrmDb } from './client';
import { siteSettings } from './schema';

// 断言一律直接查 DB 行、绕开 30s 内存缓存：updateSiteSettings 写完 DB 后会用
// 完整的 next 重置缓存，缓存期内的 getSiteSettings 永远"看似正确"，只有 DB
// 行本身能暴露漏写的列。

function dbRow() {
  const row = getOrmDb().select().from(siteSettings).where(eq(siteSettings.id, 1)).get();
  if (!row) throw new Error('site_settings row missing');
  return row;
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
});

afterEach(() => {
  setSiteSettingsLinkProvider(null);
});

describe('updateSiteSettings 持久化', () => {
  test('language 落库', () => {
    updateSiteSettings({ language: 'zh_CN' });
    expect(dbRow().language).toBe('zh_CN');

    updateSiteSettings({ language: 'en_US' });
    expect(dbRow().language).toBe('en_US');
  });

  test('sshReconnectMaxRetries / sshReconnectDelaySeconds 落库', () => {
    const before = dbRow();
    updateSiteSettings({
      sshReconnectMaxRetries: before.sshReconnectMaxRetries + 3,
      sshReconnectDelaySeconds: before.sshReconnectDelaySeconds + 7,
    });
    const after = dbRow();
    expect(after.sshReconnectMaxRetries).toBe(before.sshReconnectMaxRetries + 3);
    expect(after.sshReconnectDelaySeconds).toBe(before.sshReconnectDelaySeconds + 7);
  });

  test('updatedAt 随写入推进', async () => {
    const before = dbRow().updatedAt;
    // updatedAt 是 ISO 字符串，毫秒精度；隔 5ms 保证可比。
    await new Promise((r) => setTimeout(r, 5));
    updateSiteSettings({ siteName: 'persist-probe' });
    const after = dbRow();
    expect(after.siteName).toBe('persist-probe');
    expect(after.updatedAt > before).toBe(true);
  });

  test('mesh overlay of siteUrl is not written back on unrelated updates', () => {
    const storedUrl = dbRow().siteUrl;
    setSiteSettingsLinkProvider({
      linked: () => true,
      localNodeId: () => 'ab'.repeat(16),
      effectiveSiteUrl: () => 'https://hub.example/n/overlay',
    });
    expect(getSiteSettings().siteUrl).toBe('https://hub.example/n/overlay');
    updateSiteSettings({ enableBellSound: dbRow().enableBellSound });
    expect(dbRow().siteUrl).toBe(storedUrl);
    expect(getSiteSettings().siteUrl).toBe('https://hub.example/n/overlay');
  });
});
