import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { NodeSessionStore } from '../auth/node-session-store';
import * as schema from './schema';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const SESSION_POP_MIGRATION = '0064_session_pop.sql';

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

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

describe('0064_session_pop migration', () => {
  test('sessions issued before the migration keep working without a proof requirement', () => {
    const sqlite = migratedUpTo(SESSION_POP_MIGRATION);
    try {
      sqlite.run(
        "insert into users (id, username, root_public_key, root_epoch, kdf_params_json, key_log_head_seq, key_log_head_hash, created_at, updated_at) values ('u1', 'alice', x'01', 0, '{}', 0, x'02', 1, 1)"
      );
      const sid = Buffer.alloc(32, 9);
      sqlite
        .query(
          "insert into node_sessions (sid, user_id, via_node_id, sess_public_key, delegation_method, issued_at, expires_at, hard_expires_at, renewed_at) values (?, 'u1', 'self', ?, 'root', 1, 9999999999999, 9999999999999, 1)"
        )
        .run(sid, Buffer.alloc(32, 1));

      for (const statement of statementsOf(SESSION_POP_MIGRATION)) sqlite.run(statement);

      expect(sqlite.query('select pop_required from node_sessions').get()).toEqual({
        pop_required: 0,
      });
      const store = new NodeSessionStore(drizzle(sqlite, { schema }));
      const verified = store.verify(sid.toString('base64url'), { viaNodeId: 'self', now: 2 });
      expect(verified.ok && verified.session.popRequired).toBe(false);
      expect(verified.ok && verified.session.sessPublicKey).toEqual(new Uint8Array(32).fill(1));

      const issued = store.issue({
        userId: 'u1',
        viaNodeId: 'self',
        sessPublicKey: new Uint8Array(32).fill(5),
        delegationMethod: 'root',
        now: 3,
        popRequired: true,
      });
      const fresh = store.verify(issued.sid, { viaNodeId: 'self', now: 4 });
      expect(fresh.ok && fresh.session.popRequired).toBe(true);
      expect(fresh.ok && fresh.session.sessPublicKey).toEqual(new Uint8Array(32).fill(5));
    } finally {
      sqlite.close();
    }
  });
});
