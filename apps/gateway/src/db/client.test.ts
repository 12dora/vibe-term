import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPragmas, sqliteCacheSizeKib } from './client';

const tmpPath = join(tmpdir(), `vibeterm-client-test-${process.pid}-${Date.now()}.db`);

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(tmpPath + suffix);
    } catch {
      // 旁文件可能不存在，忽略
    }
  }
});

describe('applyPragmas', () => {
  it('设置 WAL / busy_timeout / foreign_keys / synchronous', () => {
    const db = new Database(tmpPath);
    try {
      applyPragmas(db);

      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
      expect(db.query('PRAGMA mmap_size').get()).toEqual({ mmap_size: 0 });
      expect(db.query('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 500 });
      const cache = db.query('PRAGMA cache_size').get() as { cache_size: number };
      expect(cache.cache_size === -4000 || cache.cache_size === -2000).toBe(true);
    } finally {
      db.close();
    }
  });

  it('small profile 用更小的 cache_size', () => {
    expect(sqliteCacheSizeKib('standard')).toBe(-4000);
    expect(sqliteCacheSizeKib('small')).toBe(-2000);
    const db = new Database(tmpPath);
    try {
      applyPragmas(db, 'small');
      expect(db.query('PRAGMA cache_size').get()).toEqual({ cache_size: -2000 });
    } finally {
      db.close();
    }
  });
});
