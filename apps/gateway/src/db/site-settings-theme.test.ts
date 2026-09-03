import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '.';
import { getDb as getOrmDb } from './client';
import { siteSettings } from './schema';

// site_settings.theme 的 DEFAULT / CHECK 只有 DB 层能保证。raw SQL 绕开 getSiteSettings
// 的 30s 内存缓存，故约束断言一律直接读 DB 行；同进程其他测试文件共享这张表，
// 断言前先用 updateSiteSettings 把值和缓存一起置回已知状态。
function themeRow(): string {
  const row = getOrmDb().select().from(siteSettings).where(eq(siteSettings.id, 1)).get();
  if (!row) throw new Error('site_settings row missing');
  return row.theme;
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
});

describe('site_settings.theme DB 约束', () => {
  test("列声明 DEFAULT 'dark'", () => {
    const columns = getOrmDb().all("PRAGMA table_info('site_settings')") as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const theme = columns.find((column) => column.name === 'theme');
    expect(theme?.dflt_value).toBe("'dark'");
    expect(theme?.notnull).toBe(1);
  });

  test('CHECK 约束拒绝非法值（blue），行不被改写', () => {
    updateSiteSettings({ theme: 'dark' });
    const db = getOrmDb();
    expect(() => db.run("UPDATE site_settings SET theme = 'blue' WHERE id = 1")).toThrow();
    expect(themeRow()).toBe('dark');
  });

  test('CHECK 约束接受 dark 与 light', () => {
    const db = getOrmDb();
    db.run("UPDATE site_settings SET theme = 'light' WHERE id = 1");
    expect(themeRow()).toBe('light');

    db.run("UPDATE site_settings SET theme = 'dark' WHERE id = 1");
    expect(themeRow()).toBe('dark');

    updateSiteSettings({ theme: 'dark' });
    expect(getSiteSettings().theme).toBe('dark');
  });
});
