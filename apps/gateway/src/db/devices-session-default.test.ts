import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb, getSqliteClient } from './client';
import { createDevice, listDevicesWithRuntimeStatus } from './devices';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function makeDevice(id: string, session?: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    type: 'local',
    session,
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

type SessionRow = { session: string | null };

function sessionOf(id: string): string | null {
  const row = getSqliteClient()
    .query('select session from devices where id = ?')
    .get(id) as SessionRow | null;
  return row?.session ?? null;
}

describe('devices.session 默认值', () => {
  test('应用层写入的新设备落库为 vibeterm', () => {
    createDevice(makeDevice('session-default-new'));
    expect(sessionOf('session-default-new')).toBe('vibeterm');
  });

  test('显式指定的 session 原样保留', () => {
    createDevice(makeDevice('session-default-explicit', 'work'));
    expect(sessionOf('session-default-explicit')).toBe('work');
  });

  test('列默认值冻结为 tmex（仅绕过应用层的裸 SQL 才会命中）', () => {
    getSqliteClient().run(
      `insert into devices (id, name, type, auth_mode, created_at, updated_at)
       values ('session-default-raw', 'raw', 'local', 'auto', '2026-01-01', '2026-01-01')`
    );
    expect(sessionOf('session-default-raw')).toBe('tmex');
  });

  test('历史行 session 为 NULL 时读取侧回落到 vibeterm', () => {
    getSqliteClient().run(
      `insert into devices (id, name, type, session, auth_mode, created_at, updated_at)
       values ('session-default-null', 'null-session', 'local', null, 'auto', '2026-01-01', '2026-01-01')`
    );
    const device = listDevicesWithRuntimeStatus().find((d) => d.id === 'session-default-null');
    expect(device?.session).toBe('vibeterm');
  });
});
