import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

describe('0044 messaging commands', () => {
  test('adds allow_commands and telegram chat user_id on a fresh db', () => {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder });
    try {
      const bots = sqlite.query('PRAGMA table_info(telegram_bots)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>;
      const allow = bots.find((column) => column.name === 'allow_commands');
      expect(allow).toBeTruthy();
      expect(allow?.notnull).toBe(1);
      expect(String(allow?.dflt_value)).toBe('0');

      const accounts = sqlite.query('PRAGMA table_info(weixin_accounts)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>;
      const wxAllow = accounts.find((column) => column.name === 'allow_commands');
      expect(wxAllow).toBeTruthy();
      expect(wxAllow?.notnull).toBe(1);
      expect(String(wxAllow?.dflt_value)).toBe('0');

      const chats = sqlite.query('PRAGMA table_info(telegram_bot_chats)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const userId = chats.find((column) => column.name === 'user_id');
      expect(userId).toBeTruthy();
      expect(userId?.notnull).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
