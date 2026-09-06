import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const SESSION_DEFAULT_MIGRATION = '0054_devices_session_default.sql';

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 按文件名顺序回放到 `until` 之前：造出「升级前」的老库。 */
function migratedUpTo(until: string): Database {
  const sqlite = new Database(':memory:');
  sqlite.run('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrationsFolder)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    if (name === until) break;
    for (const statement of statementsOf(name)) sqlite.run(statement);
  }
  return sqlite;
}

function insertDevice(sqlite: Database, id: string, session: string | null): void {
  if (session === null) {
    sqlite.run(
      `insert into devices (id, name, type, auth_mode, created_at, updated_at)
       values (?, ?, 'local', 'auto', '2026-01-01', '2026-01-01')`,
      [id, id]
    );
    return;
  }
  sqlite.run(
    `insert into devices (id, name, type, session, auth_mode, created_at, updated_at)
     values (?, ?, 'local', ?, 'auto', '2026-01-01', '2026-01-01')`,
    [id, id, session]
  );
}

describe('0054_devices_session_default migration', () => {
  test('把列默认值改成 vibeterm，已有行的值原样保留', () => {
    const sqlite = migratedUpTo(SESSION_DEFAULT_MIGRATION);
    try {
      insertDevice(sqlite, 'legacy-default', null);
      insertDevice(sqlite, 'explicit', 'work');
      sqlite.run(
        `insert into device_runtime_status (device_id, tmux_available)
         values ('explicit', 0)`
      );
      expect(
        (
          sqlite.query('select session from devices where id = ?').get('legacy-default') as {
            session: string;
          }
        ).session
      ).toBe('tmex');

      for (const statement of statementsOf(SESSION_DEFAULT_MIGRATION)) sqlite.run(statement);

      const rows = sqlite
        .query('select id, session, sort_order from devices order by id')
        .all() as Array<{ id: string; session: string; sort_order: number }>;
      expect(rows).toEqual([
        { id: 'explicit', session: 'work', sort_order: 0 },
        { id: 'legacy-default', session: 'tmex', sort_order: 0 },
      ]);

      insertDevice(sqlite, 'fresh', null);
      expect(
        (
          sqlite.query('select session from devices where id = ?').get('fresh') as {
            session: string;
          }
        ).session
      ).toBe('vibeterm');
    } finally {
      sqlite.close();
    }
  });

  test('重建后 CHECK 约束与外键仍然生效', () => {
    const sqlite = migratedUpTo(SESSION_DEFAULT_MIGRATION);
    try {
      insertDevice(sqlite, 'keeper', 'work');
      for (const statement of statementsOf(SESSION_DEFAULT_MIGRATION)) sqlite.run(statement);
      sqlite.run('PRAGMA foreign_keys = ON');

      expect(() => insertDevice(sqlite, 'bad-auth-mode', 'x')).not.toThrow();
      expect(() =>
        sqlite.run(
          `insert into devices (id, name, type, auth_mode, created_at, updated_at)
           values ('bad-type', 'bad', 'nope', 'auto', '2026-01-01', '2026-01-01')`
        )
      ).toThrow();
      expect(() =>
        sqlite.run(
          `insert into devices (id, name, type, auth_mode, created_at, updated_at)
           values ('bad-auth', 'bad', 'local', 'nope', '2026-01-01', '2026-01-01')`
        )
      ).toThrow();

      // 级联外键仍指向重建后的 devices
      sqlite.run(
        `insert into device_runtime_status (device_id, tmux_available) values ('keeper', 0)`
      );
      sqlite.run(`delete from devices where id = 'keeper'`);
      expect(
        (sqlite.query('select count(*) as n from device_runtime_status').get() as { n: number }).n
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
