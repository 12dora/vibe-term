import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Device } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb, getSqliteClient } from './client';
import {
  createDevice,
  getDeviceRuntimeStatus,
  getDeviceTreeOrder,
  getDeviceTreeOrders,
  listDevicesWithRuntimeStatus,
  setWindowOrder,
  updateDeviceRuntimeStatus,
} from './devices';
import { deviceRuntimeStatus } from './schema';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function makeDevice(id: string, name: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

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

describe('listDevicesWithRuntimeStatus', () => {
  test('left join 一次查出状态，缺行时用默认值', () => {
    const withStatus = 'r3-join-status';
    const missingStatus = 'r3-join-missing';
    createDevice(makeDevice(withStatus, 'with-status'));
    createDevice(makeDevice(missingStatus, 'missing-status'));
    updateDeviceRuntimeStatus(withStatus, {
      lastSeenAt: '2026-06-13T12:00:00.000Z',
      tmuxAvailable: true,
      lastError: 'boom',
      lastErrorType: 'ssh',
    });
    getOrmDb()
      .delete(deviceRuntimeStatus)
      .where(eq(deviceRuntimeStatus.deviceId, missingStatus))
      .run();

    const sqls = captureSql(() => {
      const rows = listDevicesWithRuntimeStatus();
      const found = rows.find((d) => d.id === withStatus);
      const missing = rows.find((d) => d.id === missingStatus);
      expect(found?.lastSeenAt).toBe('2026-06-13T12:00:00.000Z');
      expect(found?.tmuxAvailable).toBe(true);
      expect(found?.lastError).toBe('boom');
      expect(found?.lastErrorType).toBe('ssh');
      expect(missing?.lastSeenAt).toBeNull();
      expect(missing?.tmuxAvailable).toBe(false);
      expect(missing?.lastError).toBeNull();
      expect(missing?.lastErrorType).toBeNull();
    });

    expect(sqls.filter((sql) => /^\s*select\b/i.test(sql))).toHaveLength(1);
    expect(getDeviceRuntimeStatus(withStatus).tmuxAvailable).toBe(true);
  });
});

describe('getDeviceTreeOrders', () => {
  test('IN 批量查询，缺行时返回空 windows/panes', () => {
    const withOrder = 'r3-tree-order';
    const withoutOrder = 'r3-tree-empty';
    createDevice(makeDevice(withOrder, 'ordered'));
    createDevice(makeDevice(withoutOrder, 'unordered'));
    setWindowOrder(withOrder, ['@2', '@1']);

    const sqls = captureSql(() => {
      const map = getDeviceTreeOrders([withOrder, withoutOrder, 'no-such-device']);
      expect(map.get(withOrder)).toEqual({
        deviceId: withOrder,
        windows: ['@2', '@1'],
        panes: {},
      });
      expect(map.get(withoutOrder)).toEqual({
        deviceId: withoutOrder,
        windows: [],
        panes: {},
      });
      expect(map.get('no-such-device')).toEqual({
        deviceId: 'no-such-device',
        windows: [],
        panes: {},
      });
    });

    expect(sqls.filter((sql) => /^\s*select\b/i.test(sql))).toHaveLength(1);
    expect(sqls[0]?.toLowerCase()).toContain(' in ');
    expect(getDeviceTreeOrder(withOrder).windows).toEqual(['@2', '@1']);
    expect(getDeviceTreeOrders([])).toEqual(new Map());
  });
});
