import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const REBUILD_MIGRATION = '0028_magical_doctor_doom.sql';

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function applyMigration(db: Database, name: string): void {
  for (const statement of statementsOf(name)) db.run(statement);
}

function createDbAt0027(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  const names = readdirSync(migrationsFolder)
    .filter((name) => name.endsWith('.sql') && name < REBUILD_MIGRATION)
    .sort();
  expect(names[names.length - 1]).toBe('0027_tunnel_config.sql');
  for (const name of names) applyMigration(db, name);
  return db;
}

describe('0028 agent_sessions rebuild preserves children', () => {
  test('upgrading a 0027 db keeps messages, queued messages, confirmations and FK check is clean', () => {
    const db = createDbAt0027();
    const now = '2026-08-30T00:00:00.000Z';
    db.run(
      `INSERT INTO devices (id, name, type, auth_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['dev-1', 'local', 'local', 'agent', now, now]
    );
    db.run(
      `INSERT INTO agent_sessions (
        id, title, node_id, device_id, pane_id, model_id, write_mode,
        use_provider_web_search, provider_hosted_tools, allow_control_chars,
        status, max_steps_per_turn, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-1',
        'keep-me',
        null,
        'dev-1',
        '%1',
        'model',
        'confirm',
        0,
        '[]',
        0,
        'idle',
        25,
        now,
        now,
      ]
    );
    db.run(
      `INSERT INTO agent_messages (id, session_id, seq, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['msg-1', 'sess-1', 1, 'user', '{"role":"user","content":"hello"}', now]
    );
    db.run(
      `INSERT INTO agent_queued_messages (id, session_id, seq, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['q-1', 'sess-1', 1, 'queued', now]
    );
    db.run(
      `INSERT INTO agent_confirmations (
        id, session_id, tool_name, tool_call_id, input_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['c-1', 'sess-1', 'send_input', 'call-1', '{}', 'pending', now]
    );

    db.run('BEGIN');
    applyMigration(db, REBUILD_MIGRATION);
    db.run('COMMIT');

    const session = db.query('SELECT id, title, device_id FROM agent_sessions').get() as {
      id: string;
      title: string;
      device_id: string;
    };
    expect(session).toEqual({ id: 'sess-1', title: 'keep-me', device_id: 'dev-1' });

    const messages = db.query('SELECT id, content FROM agent_messages').all() as Array<{
      id: string;
      content: string;
    }>;
    expect(messages).toEqual([{ id: 'msg-1', content: '{"role":"user","content":"hello"}' }]);

    const queued = db.query('SELECT id, text FROM agent_queued_messages').all() as Array<{
      id: string;
      text: string;
    }>;
    expect(queued).toEqual([{ id: 'q-1', text: 'queued' }]);

    const confirmations = db.query('SELECT id, tool_name FROM agent_confirmations').all() as Array<{
      id: string;
      tool_name: string;
    }>;
    expect(confirmations).toEqual([{ id: 'c-1', tool_name: 'send_input' }]);

    const fk = db.query('PRAGMA foreign_key_check').all();
    expect(fk).toEqual([]);

    const fks = db.query('PRAGMA foreign_key_list(agent_sessions)').all() as Array<{
      from: string;
      table: string;
    }>;
    expect(fks.some((row) => row.from === 'device_id' && row.table === 'devices')).toBe(false);

    db.close();
  });
});
