import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { handleThemeApiRequest } from './theme';

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const response = await handleThemeApiRequest(req, path);
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
});

describe('GET /api/settings/theme', () => {
  test('返回当前主题与 serverTimestamp', async () => {
    const { status, json } = await call('GET', '/api/settings/theme');
    expect(status).toBe(200);
    expect(json.theme).toBe('dark');
    expect(typeof json.serverTimestamp).toBe('number');
    expect(json.serverTimestamp).toBeGreaterThan(0);
  });

  test('反映 DB 中的最新主题', async () => {
    updateSiteSettings({ theme: 'light' });
    const { status, json } = await call('GET', '/api/settings/theme');
    expect(status).toBe(200);
    expect(json.theme).toBe('light');

    updateSiteSettings({ theme: 'dark' });
    const after = await call('GET', '/api/settings/theme');
    expect(after.json.theme).toBe('dark');
  });
});

describe('POST /api/settings/theme', () => {
  test('合法 theme=light 写入并返回 serverTimestamp', async () => {
    const before = getSiteSettings().theme;
    expect(before).toBe('dark');

    const { status, json } = await call('POST', '/api/settings/theme', { theme: 'light' });
    expect(status).toBe(200);
    expect(json.theme).toBe('light');
    expect(typeof json.serverTimestamp).toBe('number');
    expect(json.serverTimestamp).toBeGreaterThan(0);

    const after = getSiteSettings().theme;
    expect(after).toBe('light');

    updateSiteSettings({ theme: 'dark' });
  });

  test('合法 theme=dark 写入', async () => {
    updateSiteSettings({ theme: 'light' });
    const { status, json } = await call('POST', '/api/settings/theme', { theme: 'dark' });
    expect(status).toBe(200);
    expect(json.theme).toBe('dark');
    expect(getSiteSettings().theme).toBe('dark');
  });

  test('非法 theme 值（blue）返回 400', async () => {
    const { status, json } = await call('POST', '/api/settings/theme', { theme: 'blue' });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  test('theme 缺失返回 400', async () => {
    const { status } = await call('POST', '/api/settings/theme', {});
    expect(status).toBe(400);
  });

  test('theme 类型错误（数字）返回 400', async () => {
    const { status } = await call('POST', '/api/settings/theme', { theme: 42 });
    expect(status).toBe(400);
  });

  test('不采纳客户端 timestamp（仅服务端分配）', async () => {
    const { status, json } = await call('POST', '/api/settings/theme', {
      theme: 'light',
      serverTimestamp: 12345,
    });
    expect(status).toBe(200);
    expect(json.serverTimestamp).not.toBe(12345);
    expect(typeof json.serverTimestamp).toBe('number');

    updateSiteSettings({ theme: 'dark' });
  });
});

describe('site_settings.theme DB 约束', () => {
  test('DEFAULT 为 dark', () => {
    const settings = getSiteSettings();
    expect(settings.theme).toBe('dark');
  });

  test('CHECK 约束拒绝非法值（blue）', () => {
    const db = getOrmDb();
    expect(() => db.run("UPDATE site_settings SET theme = 'blue' WHERE id = 1")).toThrow();
  });

  test('CHECK 约束接受 dark', () => {
    const db = getOrmDb();
    db.run("UPDATE site_settings SET theme = 'dark' WHERE id = 1");
    expect(getSiteSettings().theme).toBe('dark');
  });
});
