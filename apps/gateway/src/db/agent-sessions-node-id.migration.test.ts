import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

describe('0026 agent_sessions.node_id', () => {
  test('fresh db migration adds nullable node_id', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder });
    const cols = sqlite.query('PRAGMA table_info(agent_sessions)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const nodeId = cols.find((c) => c.name === 'node_id');
    expect(nodeId).toBeDefined();
    expect(nodeId?.notnull).toBe(0);
    const indexes = sqlite
      .query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('index', 'agent_sessions_node_id_idx') as { name: string } | null;
    expect(indexes?.name).toBe('agent_sessions_node_id_idx');
    const fks = sqlite.query('PRAGMA foreign_key_list(agent_sessions)').all() as Array<{
      from: string;
      table: string;
    }>;
    expect(fks.some((fk) => fk.from === 'device_id' && fk.table === 'devices')).toBe(false);
    sqlite.close();
  });
});
