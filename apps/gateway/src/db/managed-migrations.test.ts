import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import journal from '../../drizzle/meta/_journal.json';
import { MANAGED_MIGRATION_FILES } from './managed-migrations';

const DRIZZLE_DIR = join(import.meta.dir, '../../drizzle');

// 新迁移漏加进打包清单时，安装版会静默跳过该迁移（round 32 已踩过一次）。
describe('managed migrations manifest', () => {
  test('matches the drizzle journal in order', () => {
    const fromJournal = journal.entries.map((entry) => `${entry.tag}.sql`);
    expect([...MANAGED_MIGRATION_FILES]).toEqual(fromJournal);
  });

  test('matches every .sql file in the drizzle directory', () => {
    const onDisk = readdirSync(DRIZZLE_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect([...MANAGED_MIGRATION_FILES].sort()).toEqual(onDisk);
  });
});
