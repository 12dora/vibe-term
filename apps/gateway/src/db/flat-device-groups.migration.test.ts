// 0025 扁平化迁移：嵌套分组提升到根层后按旧树的前序重新编号，设备 placement 删除、节点 placement 保留。
// 用 0000..0024 建库（与 drizzle migrator 同样按 statement-breakpoint 逐条执行），塞旧数据，再单独跑 0025。

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');
const FLAT_MIGRATION = '0025_flat_device_groups.sql';

function statementsOf(name: string): string[] {
  return readFileSync(resolve(migrationsFolder, name), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function applyMigration(db: Database, name: string): void {
  for (const statement of statementsOf(name)) db.run(statement);
}

function createDbBefore0025(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  const names = readdirSync(migrationsFolder)
    .filter((name) => name.endsWith('.sql') && name < FLAT_MIGRATION)
    .sort();
  expect(names[names.length - 1]).toBe('0024_narrow_tomas.sql');
  for (const name of names) applyMigration(db, name);
  return db;
}

function insertFolder(
  db: Database,
  id: string,
  parentId: string | null,
  sortOrder: number,
  createdAt = '2026-08-01T00:00:00.000Z'
): void {
  db.run(
    'INSERT INTO device_folders (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, id, parentId, sortOrder, createdAt, createdAt]
  );
}

function insertPlacement(
  db: Database,
  kind: 'node' | 'device',
  nodeId: string,
  deviceId: string | null,
  folderId: string | null,
  sortOrder: number
): void {
  const itemKey = kind === 'node' ? `node:${nodeId}` : `device:${nodeId}:${deviceId}`;
  db.run(
    'INSERT INTO device_folder_placements (item_key, kind, node_id, device_id, folder_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [itemKey, kind, nodeId, deviceId, folderId, sortOrder, 't', 't']
  );
}

interface FolderRow {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

interface PlacementRow {
  item_key: string;
  kind: string;
  device_id: string | null;
  folder_id: string | null;
  sort_order: number;
}

describe('0025_flat_device_groups', () => {
  test('嵌套分组按旧树前序重新编号为 0..n-1，parent_id 全部置空', () => {
    const db = createDbBefore0025();
    // 旧树（各自父级下的 sort_order 有重叠）：
    //   b(1) ─┬─ b1(0) ─── b1x(0)
    //         └─ b2(1)
    //   a(0) ─── a1(0)
    //   c(2)
    insertFolder(db, 'a', null, 0);
    insertFolder(db, 'b', null, 1);
    insertFolder(db, 'c', null, 2);
    insertFolder(db, 'a1', 'a', 0);
    insertFolder(db, 'b1', 'b', 0);
    insertFolder(db, 'b2', 'b', 1);
    insertFolder(db, 'b1x', 'b1', 0);
    // 孤儿（父级不存在）与同序同时间的两个根：靠 created_at / id 兜底稳定
    insertFolder(db, 'orphan', 'ghost', 0, '2026-08-02T00:00:00.000Z');
    insertFolder(db, 'z-tie', null, 2, '2026-08-01T00:00:00.000Z');

    applyMigration(db, FLAT_MIGRATION);

    const rows = db
      .query('SELECT id, parent_id, sort_order FROM device_folders ORDER BY sort_order')
      .all() as FolderRow[];
    expect(rows.every((row) => row.parent_id === null)).toBe(true);
    expect(rows.map((row) => row.sort_order)).toEqual(rows.map((_row, index) => index));
    // 孤儿视为根：与 a 同序，created_at 晚于 a → 排在 a 子树之后
    expect(rows.map((row) => row.id)).toEqual([
      'a',
      'a1',
      'orphan',
      'b',
      'b1',
      'b1x',
      'b2',
      'c',
      'z-tie',
    ]);
    db.close();
  });

  test('设备 placement 删除，节点 placement 保留并按容器内重新编号', () => {
    const db = createDbBefore0025();
    insertFolder(db, 'g', null, 0);
    insertFolder(db, 'g-child', 'g', 0);
    insertPlacement(db, 'node', 'n-root-b', null, null, 7);
    insertPlacement(db, 'node', 'n-root-a', null, null, 3);
    insertPlacement(db, 'node', 'n-in-g', null, 'g', 5);
    insertPlacement(db, 'node', 'n-in-child', null, 'g-child', 0);
    insertPlacement(db, 'device', 'self', 'd1', 'g', 0);
    insertPlacement(db, 'device', 'mesh-x', 'd2', null, 0);

    applyMigration(db, FLAT_MIGRATION);

    const rows = db
      .query(
        'SELECT item_key, kind, device_id, folder_id, sort_order FROM device_folder_placements ORDER BY folder_id, sort_order'
      )
      .all() as PlacementRow[];
    expect(rows.every((row) => row.kind === 'node' && row.device_id === null)).toBe(true);
    expect(rows.map((row) => [row.item_key, row.folder_id, row.sort_order])).toEqual([
      ['node:n-root-a', null, 0],
      ['node:n-root-b', null, 1],
      ['node:n-in-g', 'g', 0],
      ['node:n-in-child', 'g-child', 0],
    ]);
    // 子分组已成为根层分组，其中的节点仍跟着它
    expect(
      (db.query("SELECT parent_id FROM device_folders WHERE id = 'g-child'").get() as FolderRow)
        .parent_id
    ).toBeNull();
    db.close();
  });

  test('对已经扁平的数据幂等', () => {
    const db = createDbBefore0025();
    insertFolder(db, 'x', null, 0);
    insertFolder(db, 'y', null, 1);
    insertPlacement(db, 'node', 'n1', null, 'x', 0);
    applyMigration(db, FLAT_MIGRATION);
    applyMigration(db, FLAT_MIGRATION);
    const rows = db
      .query('SELECT id, sort_order FROM device_folders ORDER BY sort_order')
      .all() as FolderRow[];
    expect(rows.map((row) => [row.id, row.sort_order])).toEqual([
      ['x', 0],
      ['y', 1],
    ]);
    db.close();
  });
});
