import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Device } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  DEFAULT_LOCAL_DEVICE_SEED_KEY,
  createDevice,
  ensureDefaultLocalDeviceSeeded,
  ensureSiteSettingsInitialized,
  getAllDevices,
  getGatewayKv,
} from '.';
import { getDb as getOrmDb } from './client';
import { deviceRuntimeStatus, devices, gatewayKv, siteSettings } from './schema';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterAll(() => {
  // 共享内存库：恢复 site_settings 单例，避免影响后续测试文件
  ensureSiteSettingsInitialized();
});

// 每个用例自行布置库状态：清掉 seed 标记 / 全部设备 / site_settings 单例行
function resetToFreshDatabase(): void {
  const orm = getOrmDb();
  orm.delete(gatewayKv).where(eq(gatewayKv.key, DEFAULT_LOCAL_DEVICE_SEED_KEY)).run();
  orm.delete(devices).run();
  orm.delete(siteSettings).run();
}

function makeManualDevice(id: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: 'manual',
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ensureDefaultLocalDeviceSeeded', () => {
  test('全新库：seed 一台 local 设备（字段与手动新建一致）并写入标记', () => {
    resetToFreshDatabase();

    ensureDefaultLocalDeviceSeeded();

    const all = getAllDevices();
    expect(all.length).toBe(1);
    const device = all[0];
    expect(device.name).toBe('local');
    expect(device.type).toBe('local');
    expect(device.session).toBe('tmex');
    expect(device.authMode).toBe('auto');

    // 走 createDevice 既有路径：device_runtime_status 副作用一致
    const statusRow = getOrmDb()
      .select()
      .from(deviceRuntimeStatus)
      .where(eq(deviceRuntimeStatus.deviceId, device.id))
      .get();
    expect(statusRow).toBeDefined();
    expect(statusRow?.tmuxAvailable).toBe(false);

    expect(getGatewayKv(DEFAULT_LOCAL_DEVICE_SEED_KEY)).toBe('1');
  });

  test('幂等：重复调用不追加设备', () => {
    resetToFreshDatabase();

    ensureDefaultLocalDeviceSeeded();
    const first = getAllDevices();
    expect(first.length).toBe(1);

    ensureDefaultLocalDeviceSeeded();
    const second = getAllDevices();
    expect(second.length).toBe(1);
    expect(second[0].id).toBe(first[0].id);
  });

  test('标记存在时删光设备重启不复活', () => {
    resetToFreshDatabase();
    ensureDefaultLocalDeviceSeeded();
    expect(getAllDevices().length).toBe(1);

    getOrmDb().delete(devices).run();

    ensureDefaultLocalDeviceSeeded();
    expect(getAllDevices().length).toBe(0);
  });

  test('老库（已有 site_settings 行、无设备、无标记）不追加 seed，只补写标记', () => {
    resetToFreshDatabase();
    ensureSiteSettingsInitialized();

    ensureDefaultLocalDeviceSeeded();

    expect(getAllDevices().length).toBe(0);
    expect(getGatewayKv(DEFAULT_LOCAL_DEVICE_SEED_KEY)).toBe('1');
  });

  test('已有设备（无标记）不追加 seed，只补写标记', () => {
    resetToFreshDatabase();
    createDevice(makeManualDevice('seed-test-manual'));

    ensureDefaultLocalDeviceSeeded();

    const all = getAllDevices();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe('seed-test-manual');
    expect(getGatewayKv(DEFAULT_LOCAL_DEVICE_SEED_KEY)).toBe('1');
  });

  test('启动顺序（seed 先于 site_settings 初始化）：全新库两者协作后仍只有一台 local', () => {
    resetToFreshDatabase();

    // 对齐 createGatewayRuntime 的调用顺序
    ensureDefaultLocalDeviceSeeded();
    ensureSiteSettingsInitialized();

    const all = getAllDevices();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('local');

    // 二次启动：不再追加
    ensureDefaultLocalDeviceSeeded();
    ensureSiteSettingsInitialized();
    expect(getAllDevices().length).toBe(1);
  });
});
