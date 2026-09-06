import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const PORT_MAPS_MIGRATION = '0050_port_maps.sql';

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

function tableNames(sqlite: Database): string[] {
  return (
    sqlite.query("select name from sqlite_master where type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe('0050_port_maps migration', () => {
  test('adds both port map tables and the listen index to an existing db', () => {
    const sqlite = migratedUpTo(PORT_MAPS_MIGRATION);
    try {
      expect(tableNames(sqlite)).not.toContain('port_maps');
      for (const statement of statementsOf(PORT_MAPS_MIGRATION)) sqlite.run(statement);
      const names = tableNames(sqlite);
      expect(names).toContain('port_maps');
      expect(names).toContain('port_map_exports');
      const indexes = (
        sqlite
          .query("select name from sqlite_master where type = 'index' and tbl_name = 'port_maps'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toContain('port_maps_listen_idx');
      sqlite.run(
        "insert into port_maps (id, name, listen_port, target_node_id, target_port, created_at, updated_at) values ('m', 'n', 15432, 'a', 5432, 1, 1)"
      );
      const row = sqlite.query('select listen_host, target_host, paused from port_maps').get() as {
        listen_host: string;
        target_host: string;
        paused: number;
      };
      expect(row).toEqual({ listen_host: '127.0.0.1', target_host: '127.0.0.1', paused: 0 });
    } finally {
      sqlite.close();
    }
  });
});
