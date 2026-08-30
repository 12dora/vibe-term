import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb, getSqliteClient } from './client';
import { createDevice } from './index';
import {
  createWatchRule,
  getWatchRuleState,
  upsertWatchRuleState,
  writeWatchRuleState,
} from './watch';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  const now = new Date().toISOString();
  createDevice({
    id: 'watch-upsert-device',
    name: 'watch-upsert',
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

function captureSql(fn: () => void): string[] {
  const db = getSqliteClient();
  const orig = db.prepare.bind(db);
  const sqls: string[] = [];
  db.prepare = ((sql: string) => {
    sqls.push(sql);
    return orig(sql);
  }) as typeof db.prepare;
  try {
    fn();
    return sqls;
  } finally {
    db.prepare = orig;
  }
}

describe('writeWatchRuleState', () => {
  test('写入后可读到状态，且不发 SELECT', () => {
    const rule = createWatchRule({
      name: 'no-read upsert',
      deviceId: 'watch-upsert-device',
      paneId: '%1',
      triggerType: 'match',
      pattern: 'x',
    });

    const sqls = captureSql(() => {
      writeWatchRuleState(rule.id, {
        lastSampledAt: '2026-06-13T12:00:00.000Z',
        lastValue: '42',
        consecutiveErrors: 0,
        lastError: null,
      });
    });

    expect(sqls.some((sql) => /^\s*select\b/i.test(sql))).toBe(false);
    expect(sqls.some((sql) => /^\s*insert\b/i.test(sql))).toBe(true);
    expect(getWatchRuleState(rule.id)?.lastValue).toBe('42');
    expect(writeWatchRuleState(rule.id, { lastValue: '43' })).toBeUndefined();
    expect(getWatchRuleState(rule.id)?.lastValue).toBe('43');
  });

  test('upsertWatchRuleState 仍回读行给需要返回值的调用方', () => {
    const rule = createWatchRule({
      name: 'readback upsert',
      deviceId: 'watch-upsert-device',
      paneId: '%2',
      triggerType: 'match',
      pattern: 'x',
    });

    const sqls = captureSql(() => {
      const row = upsertWatchRuleState(rule.id, { lastValue: 'keep' });
      expect(row.lastValue).toBe('keep');
    });

    expect(sqls.some((sql) => /^\s*select\b/i.test(sql))).toBe(true);
  });
});
