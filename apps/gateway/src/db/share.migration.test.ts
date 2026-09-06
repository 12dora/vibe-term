import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const PASSWORD_ENC_MIGRATION = '0048_share_password_enc.sql';

/** 按文件名顺序手工回放迁移，`until` 之后的不执行：用来造「升级前」的老库。 */
function migratedUpTo(until: string): Database {
  const sqlite = new Database(':memory:');
  sqlite.run('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrationsFolder)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (name === until) break;
    for (const statement of readFileSync(resolve(migrationsFolder, name), 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)) {
      sqlite.run(statement);
    }
  }
  return sqlite;
}

function applyMigration(sqlite: Database, name: string): void {
  for (const statement of readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    sqlite.run(statement);
  }
}

function migrated(): Database {
  const sqlite = new Database(':memory:');
  sqlite.run('PRAGMA foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder });
  return sqlite;
}

function insertShare(sqlite: Database, id: string): void {
  sqlite
    .query(
      `INSERT INTO shares (
        id, name, device_id, window_id, window_name, state, password_hash,
        origin, url, record_log, log_bytes, log_truncated, log_seq, created_at
      ) VALUES (?, 'n', 'd1', 'w1', 'win', 'active', 'h', 'https://a.example.com',
        'https://a.example.com/s/${id}', 1, 0, 0, 0, 1)`
    )
    .run(id);
}

describe('0048 shares.password_enc', () => {
  test('老库升级后新增可空 password_enc，既有分享保留 password_hash 仍可登录', () => {
    const sqlite = migratedUpTo(PASSWORD_ENC_MIGRATION);
    try {
      const before = (
        sqlite.query('PRAGMA table_info(shares)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(before).not.toContain('password_enc');
      insertShare(sqlite, 'legacy');

      applyMigration(sqlite, PASSWORD_ENC_MIGRATION);

      const column = (
        sqlite.query('PRAGMA table_info(shares)').all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((row) => row.name === 'password_enc');
      expect(column).toBeTruthy();
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();

      const legacy = sqlite.query('SELECT * FROM shares WHERE id = ?').get('legacy') as {
        password_hash: string;
        password_enc: string | null;
      };
      expect(legacy.password_hash).toBe('h');
      expect(legacy.password_enc).toBeNull();

      sqlite.query('UPDATE shares SET password_enc = ? WHERE id = ?').run('cipher', 'legacy');
      const updated = sqlite
        .query('SELECT password_enc FROM shares WHERE id = ?')
        .get('legacy') as {
        password_enc: string | null;
      };
      expect(updated.password_enc).toBe('cipher');
    } finally {
      sqlite.close();
    }
  });
});

describe('0047 share tables', () => {
  test('shares 表字段与默认值', () => {
    const sqlite = migrated();
    try {
      const columns = sqlite.query('PRAGMA table_info(shares)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const names = columns.map((row) => row.name);
      expect(names).toEqual([
        'id',
        'name',
        'device_id',
        'window_id',
        'window_name',
        'state',
        'end_reason',
        'password_hash',
        'origin',
        'url',
        'record_log',
        'log_bytes',
        'log_truncated',
        'log_seq',
        'log_purged_at',
        'created_at',
        'expires_at',
        'ended_at',
        'password_enc',
      ]);
      insertShare(sqlite, 's1');
      const row = sqlite.query('SELECT * FROM shares WHERE id = ?').get('s1') as {
        state: string;
        end_reason: string | null;
        expires_at: number | null;
        ended_at: number | null;
        log_truncated: number;
      };
      expect(row.state).toBe('active');
      expect(row.end_reason).toBeNull();
      expect(row.expires_at).toBeNull();
      expect(row.ended_at).toBeNull();
      expect(row.log_truncated).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('state / end_reason 有 CHECK 约束', () => {
    const sqlite = migrated();
    try {
      insertShare(sqlite, 's1');
      expect(() => sqlite.query("UPDATE shares SET state = 'weird'").run()).toThrow();
      expect(() => sqlite.query("UPDATE shares SET end_reason = 'weird'").run()).toThrow();
      sqlite.query("UPDATE shares SET state = 'ended', end_reason = 'expired'").run();
      const row = sqlite.query('SELECT end_reason FROM shares').get() as { end_reason: string };
      expect(row.end_reason).toBe('expired');
    } finally {
      sqlite.close();
    }
  });

  test('share_logs 主键 (share_id, seq)，kind 受限，随分享级联删除', () => {
    const sqlite = migrated();
    try {
      insertShare(sqlite, 's1');
      const insertLog = sqlite.query(
        'INSERT INTO share_logs (share_id, seq, at, kind, pane_id, cols, rows, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insertLog.run('s1', 1, 10, 'checkpoint', '%1', 80, 24, Buffer.from('a'));
      insertLog.run('s1', 2, 11, 'out', '%1', null, null, Buffer.from('bc'));
      expect(() => insertLog.run('s1', 2, 12, 'out', '%1', null, null, Buffer.from('x'))).toThrow();
      expect(() =>
        insertLog.run('s1', 3, 12, 'nope', '%1', null, null, Buffer.from('x'))
      ).toThrow();
      expect(() =>
        insertLog.run('missing', 1, 12, 'out', '%1', null, null, Buffer.from('x'))
      ).toThrow();

      sqlite.query('DELETE FROM shares WHERE id = ?').run('s1');
      const left = sqlite.query('SELECT count(*) as n FROM share_logs').get() as { n: number };
      expect(left.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('share_access_tokens token_hash 唯一且随分享级联删除', () => {
    const sqlite = migrated();
    try {
      insertShare(sqlite, 's1');
      const insertToken = sqlite.query(
        'INSERT INTO share_access_tokens (id, share_id, token_hash, client_ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertToken.run('a1', 's1', 'hash1', '203.0.113.1', 1, 2);
      expect(() => insertToken.run('a2', 's1', 'hash1', null, 1, 2)).toThrow();
      insertToken.run('a2', 's1', 'hash2', null, 1, 2);
      sqlite.query('DELETE FROM shares WHERE id = ?').run('s1');
      const left = sqlite.query('SELECT count(*) as n FROM share_access_tokens').get() as {
        n: number;
      };
      expect(left.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('share_settings 单例约束与默认值', () => {
    const sqlite = migrated();
    try {
      sqlite.query('INSERT INTO share_settings (id, updated_at) VALUES (1, 5)').run();
      const row = sqlite.query('SELECT * FROM share_settings WHERE id = 1').get() as {
        record_logs: number;
        log_retention_days: number;
        log_max_bytes: number;
        default_origin: string | null;
      };
      expect(row.record_logs).toBe(1);
      expect(row.log_retention_days).toBe(30);
      expect(row.log_max_bytes).toBe(52_428_800);
      expect(row.default_origin).toBeNull();
      expect(() =>
        sqlite.query('INSERT INTO share_settings (id, updated_at) VALUES (2, 5)').run()
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
