import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const PANE_GRANTS_MIGRATION = '0051_agent_pane_grants.sql';

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

function columnNames(sqlite: Database, table: string): string[] {
  return (sqlite.query(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

describe('0051_agent_pane_grants migration', () => {
  test('在老库上补出授权表与会话的 remote_grant 列，且保留既有会话', () => {
    const sqlite = migratedUpTo(PANE_GRANTS_MIGRATION);
    try {
      sqlite.run(
        `insert into agent_sessions (id, title, model_id, write_mode, use_provider_web_search, provider_hosted_tools, allow_control_chars, status, max_steps_per_turn, created_at, updated_at)
         values ('s1', 'old', 'm', 'confirm', 0, '[]', 0, 'idle', 25, 'now', 'now')`
      );
      expect(columnNames(sqlite, 'agent_sessions')).not.toContain('remote_grant');

      for (const statement of statementsOf(PANE_GRANTS_MIGRATION)) sqlite.run(statement);

      expect(columnNames(sqlite, 'agent_pane_grants').sort()).toEqual([
        'created_at',
        'device_id',
        'expires_at',
        'from_node_id',
        'id',
        'last_used_at',
        'pane_id',
        'token_hash',
      ]);
      expect(columnNames(sqlite, 'agent_sessions')).toContain('remote_grant');
      const row = sqlite
        .query('select id, remote_grant from agent_sessions where id = ?')
        .get('s1') as { id: string; remote_grant: string | null };
      expect(row).toEqual({ id: 's1', remote_grant: null });

      const indexes = (
        sqlite
          .query("select name from sqlite_master where type = 'index' and tbl_name = ?")
          .all('agent_pane_grants') as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toContain('agent_pane_grants_from_node_idx');
    } finally {
      sqlite.close();
    }
  });
});
