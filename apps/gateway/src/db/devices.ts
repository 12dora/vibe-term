import { hostname } from 'node:os';
import type { Device, DeviceRuntimeStatus } from '@tmex/shared';
import { asc, count, desc, eq, max } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { removeDeviceFolderPlacementsForDevice } from './device-folders';
import { getGatewayKv, setGatewayKv } from './kv';
import { toDevice } from './mappers';
import { deviceRuntimeStatus, deviceTreeOrder, devices, siteSettings } from './schema';
import type { DeviceTreeOrderRecord } from './types';

export type { DeviceTreeOrderRecord };

export const DEFAULT_LOCAL_DEVICE_SEED_KEY = 'default_local_device_seeded';

/**
 * 首次建库时自动创建一台本地设备（name 为当前 hostname、type 为 local，其余字段与
 * 手动新建 local 设备一致），并写入一次性标记保证只 seed 一次——用户删光设备后重启不复活。
 *
 * 全新库的判定：标记缺失且 site_settings 尚无行且 devices 为空。老库每次启动都会
 * 写入 site_settings 单例行，因此本函数必须在 ensureSiteSettingsInitialized 之前
 * 调用，否则新库会被误判为老库；存量老库（有 site_settings 行或已有设备）只补写
 * 标记、不追加 seed。
 */
export function ensureDefaultLocalDeviceSeeded(): void {
  if (getGatewayKv(DEFAULT_LOCAL_DEVICE_SEED_KEY) !== null) {
    return;
  }

  const orm = getOrmDb();
  const siteSettingsRow = orm.select({ id: siteSettings.id }).from(siteSettings).get();
  const deviceCountRow = orm.select({ total: count() }).from(devices).get();
  const isFreshDatabase = !siteSettingsRow && Number(deviceCountRow?.total ?? 0) === 0;

  if (isFreshDatabase) {
    const now = new Date().toISOString();
    createDevice({
      id: crypto.randomUUID(),
      name: hostname().trim() || 'local',
      type: 'local',
      session: 'tmex',
      authMode: 'auto',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  setGatewayKv(DEFAULT_LOCAL_DEVICE_SEED_KEY, '1');
}

export function createDevice(device: Device): void {
  const orm = getOrmDb();

  orm.transaction((tx) => {
    // 新设备排到末尾：sort_order = 当前最大值 + 1
    const maxRow = tx
      .select({ value: max(devices.sortOrder) })
      .from(devices)
      .get();
    const nextSortOrder = (maxRow?.value ?? -1) + 1;

    tx.insert(devices)
      .values({
        id: device.id,
        name: device.name,
        type: device.type,
        host: device.host ?? null,
        port: device.port ?? 22,
        username: device.username ?? null,
        sshConfigRef: device.sshConfigRef ?? null,
        session: device.session ?? 'tmex',
        authMode: device.authMode,
        passwordEnc: device.passwordEnc ?? null,
        privateKeyEnc: device.privateKeyEnc ?? null,
        privateKeyPassphraseEnc: device.privateKeyPassphraseEnc ?? null,
        defaultWorkingDir: device.defaultWorkingDir ?? null,
        sortOrder: nextSortOrder,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
      })
      .run();

    tx.insert(deviceRuntimeStatus)
      .values({
        deviceId: device.id,
        lastSeenAt: null,
        tmuxAvailable: false,
        lastError: null,
        lastErrorType: null,
      })
      .onConflictDoNothing({ target: deviceRuntimeStatus.deviceId })
      .run();
  });
}

export function getDeviceById(id: string): Device | null {
  const orm = getOrmDb();
  const row = orm.select().from(devices).where(eq(devices.id, id)).get();
  if (!row) {
    return null;
  }
  return toDevice(row);
}

export function getAllDevices(): Device[] {
  const orm = getOrmDb();
  // 统一排序源：先按自定义 sort_order，迁移后全 0 时按 created_at 兜底稳定排序
  return orm
    .select()
    .from(devices)
    .orderBy(asc(devices.sortOrder), desc(devices.createdAt))
    .all()
    .map(toDevice);
}

export function reorderDevices(orderedIds: string[]): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(devices).set({ sortOrder: index, updatedAt: now }).where(eq(devices.id, id)).run();
    });
  });
}

export function updateDevice(id: string, updates: Partial<Device>): void {
  const orm = getOrmDb();
  const setValues: Partial<typeof devices.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.host !== undefined) {
    setValues.host = updates.host;
  }
  if (updates.port !== undefined) {
    setValues.port = updates.port;
  }
  if (updates.username !== undefined) {
    setValues.username = updates.username;
  }
  if (updates.sshConfigRef !== undefined) {
    setValues.sshConfigRef = updates.sshConfigRef;
  }
  if (updates.session !== undefined) {
    setValues.session = updates.session;
  }
  if (updates.authMode !== undefined) {
    setValues.authMode = updates.authMode;
  }
  if (updates.passwordEnc !== undefined) {
    setValues.passwordEnc = updates.passwordEnc;
  }
  if (updates.privateKeyEnc !== undefined) {
    setValues.privateKeyEnc = updates.privateKeyEnc;
  }
  if (updates.privateKeyPassphraseEnc !== undefined) {
    setValues.privateKeyPassphraseEnc = updates.privateKeyPassphraseEnc;
  }
  if (updates.defaultWorkingDir !== undefined) {
    setValues.defaultWorkingDir = updates.defaultWorkingDir || null;
  }

  orm.update(devices).set(setValues).where(eq(devices.id, id)).run();
}

/** 删设备与清掉它在文件夹里的 placement 同一事务，避免留下孤儿 placement */
export function deleteDevice(id: string): void {
  const orm = getOrmDb();
  orm.transaction((tx) => {
    tx.delete(devices).where(eq(devices.id, id)).run();
    removeDeviceFolderPlacementsForDevice(id, tx);
  });
}

export function getDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(deviceTreeOrder)
    .where(eq(deviceTreeOrder.deviceId, deviceId))
    .get();

  if (!row) {
    return { deviceId, windows: [], panes: {} };
  }

  return {
    deviceId: row.deviceId,
    windows: Array.isArray(row.windows) ? row.windows : [],
    panes: row.panes && typeof row.panes === 'object' ? row.panes : {},
  };
}

export function setWindowOrder(deviceId: string, windowIds: string[]): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm
    .insert(deviceTreeOrder)
    .values({ deviceId, windows: windowIds, panes: {}, updatedAt: now })
    .onConflictDoUpdate({
      target: deviceTreeOrder.deviceId,
      set: { windows: windowIds, updatedAt: now },
    })
    .run();
}

export function setPaneOrder(deviceId: string, windowId: string, paneIds: string[]): void {
  const current = getDeviceTreeOrder(deviceId);
  const nextPanes = { ...current.panes, [windowId]: paneIds };
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm
    .insert(deviceTreeOrder)
    .values({ deviceId, windows: current.windows, panes: nextPanes, updatedAt: now })
    .onConflictDoUpdate({
      target: deviceTreeOrder.deviceId,
      set: { panes: nextPanes, updatedAt: now },
    })
    .run();
}

export function getDeviceRuntimeStatus(deviceId: string): DeviceRuntimeStatus {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(deviceRuntimeStatus)
    .where(eq(deviceRuntimeStatus.deviceId, deviceId))
    .get();

  if (!row) {
    return {
      deviceId,
      lastSeenAt: null,
      tmuxAvailable: false,
      lastError: null,
      lastErrorType: null,
    };
  }

  return {
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt,
    tmuxAvailable: row.tmuxAvailable,
    lastError: row.lastError,
    lastErrorType: row.lastErrorType,
  };
}

export function updateDeviceRuntimeStatus(
  deviceId: string,
  status: Partial<DeviceRuntimeStatus>
): void {
  const orm = getOrmDb();
  const setValues: Partial<typeof deviceRuntimeStatus.$inferInsert> = {};

  if (status.lastSeenAt !== undefined) {
    setValues.lastSeenAt = status.lastSeenAt;
  }
  if (status.tmuxAvailable !== undefined) {
    setValues.tmuxAvailable = status.tmuxAvailable;
  }
  if (status.lastError !== undefined) {
    setValues.lastError = status.lastError;
  }
  if (status.lastErrorType !== undefined) {
    setValues.lastErrorType = status.lastErrorType;
  }

  if (Object.keys(setValues).length === 0) {
    return;
  }

  orm
    .update(deviceRuntimeStatus)
    .set(setValues)
    .where(eq(deviceRuntimeStatus.deviceId, deviceId))
    .run();
}
