import {
  DEVICE_FOLDER_SELF_NODE_ID,
  type DeviceFolder,
  type DeviceFolderLayout,
  type DeviceFolderPlacement,
  type UpdateDeviceFolderLayoutRequest,
  deviceFolderPlacementKey,
  isDeviceFolderLayoutValid,
  normalizeFolderLayoutOrder,
  reparentOnFolderDelete,
} from '@tmex/shared';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { deviceFolderPlacements, deviceFolders } from './schema';

const PLACEMENT_KIND_NODE = 'node';

function toFolder(row: typeof deviceFolders.$inferSelect): DeviceFolder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlacement(row: typeof deviceFolderPlacements.$inferSelect): DeviceFolderPlacement {
  return {
    nodeId: row.nodeId,
    folderId: row.folderId ?? null,
    sortOrder: row.sortOrder,
  };
}

function maxFolderSortOrder(tx: ReturnType<typeof getOrmDb>): number {
  const row = tx
    .select({ value: max(deviceFolders.sortOrder) })
    .from(deviceFolders)
    .where(isNull(deviceFolders.parentId))
    .get();
  return row?.value ?? -1;
}

/**
 * 分组只有一层、placement 只认节点：库里若还有旧数据（嵌套分组 / 设备 placement），
 * 读出来时一律忽略，与迁移的扁平化结果一致。
 */
export function getDeviceFolderLayout(): DeviceFolderLayout {
  const orm = getOrmDb();
  const folders = orm
    .select()
    .from(deviceFolders)
    .where(isNull(deviceFolders.parentId))
    .orderBy(asc(deviceFolders.sortOrder))
    .all()
    .map(toFolder);
  const placements = orm
    .select()
    .from(deviceFolderPlacements)
    .where(
      and(
        eq(deviceFolderPlacements.kind, PLACEMENT_KIND_NODE),
        isNull(deviceFolderPlacements.deviceId)
      )
    )
    .orderBy(asc(deviceFolderPlacements.folderId), asc(deviceFolderPlacements.sortOrder))
    .all()
    .map(toPlacement);
  return { folders, placements };
}

export function getDeviceFolderById(id: string): DeviceFolder | null {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(deviceFolders)
    .where(and(eq(deviceFolders.id, id), isNull(deviceFolders.parentId)))
    .get();
  return row ? toFolder(row) : null;
}

export function createDeviceFolder(input: { id: string; name: string }): DeviceFolder {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const sortOrder = maxFolderSortOrder(orm) + 1;
  const row = {
    id: input.id,
    name: input.name,
    parentId: null,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  orm.insert(deviceFolders).values(row).run();
  return toFolder(row);
}

export function updateDeviceFolder(
  id: string,
  patch: { name?: string; sortOrder?: number }
): DeviceFolder | null {
  const current = getDeviceFolderById(id);
  if (!current) return null;

  const orm = getOrmDb();
  const now = new Date().toISOString();
  const next: DeviceFolder = {
    ...current,
    name: patch.name ?? current.name,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    updatedAt: now,
  };
  orm
    .update(deviceFolders)
    .set({ name: next.name, sortOrder: next.sortOrder, updatedAt: now })
    .where(eq(deviceFolders.id, id))
    .run();
  return next;
}

export function deleteDeviceFolder(id: string): boolean {
  const layout = getDeviceFolderLayout();
  if (!layout.folders.some((folder) => folder.id === id)) return false;
  const next = reparentOnFolderDelete(layout, id);
  const now = new Date().toISOString();
  const orm = getOrmDb();
  orm.transaction((tx) => {
    for (const folder of next.folders) {
      tx.update(deviceFolders)
        .set({ sortOrder: folder.sortOrder, updatedAt: now })
        .where(eq(deviceFolders.id, folder.id))
        .run();
    }
    for (const placement of next.placements) {
      tx.update(deviceFolderPlacements)
        .set({ folderId: placement.folderId, sortOrder: placement.sortOrder, updatedAt: now })
        .where(eq(deviceFolderPlacements.itemKey, deviceFolderPlacementKey(placement.nodeId)))
        .run();
    }
    tx.delete(deviceFolders).where(eq(deviceFolders.id, id)).run();
  });
  return true;
}

/**
 * 整表替换。请求里的分组 id 集合必须与库中一致；布局本身（分组唯一、节点唯一、folderId
 * 存在）不合法直接抛错——这是绕过 HTTP 层直接调用时的最后一道防线。
 */
export function replaceDeviceFolderLayout(
  layout: UpdateDeviceFolderLayoutRequest
): DeviceFolderLayout {
  const current = getDeviceFolderLayout();
  const byId = new Map(current.folders.map((folder) => [folder.id, folder]));
  if (
    layout.folders.length !== byId.size ||
    layout.folders.some((folder) => !byId.has(folder.id))
  ) {
    throw new Error('device folder layout: folder id set mismatch');
  }
  if (!isDeviceFolderLayoutValid(layout)) {
    throw new Error('device folder layout: invalid layout');
  }
  const now = new Date().toISOString();
  const folders: DeviceFolder[] = layout.folders.map((item) => {
    const prev = byId.get(item.id) as DeviceFolder;
    return { ...prev, sortOrder: item.sortOrder, updatedAt: now };
  });
  const normalized = normalizeFolderLayoutOrder({
    folders,
    placements: layout.placements.map((placement) => ({
      nodeId: placement.nodeId,
      folderId: placement.folderId,
      sortOrder: placement.sortOrder,
    })),
  });
  const orm = getOrmDb();
  orm.transaction((tx) => {
    for (const folder of normalized.folders) {
      tx.update(deviceFolders)
        .set({ sortOrder: folder.sortOrder, updatedAt: now })
        .where(eq(deviceFolders.id, folder.id))
        .run();
    }
    tx.delete(deviceFolderPlacements).run();
    for (const placement of normalized.placements) {
      tx.insert(deviceFolderPlacements)
        .values({
          itemKey: deviceFolderPlacementKey(placement.nodeId),
          kind: PLACEMENT_KIND_NODE,
          nodeId: placement.nodeId,
          deviceId: null,
          folderId: placement.folderId,
          sortOrder: placement.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });
  return getDeviceFolderLayout();
}

/** 恢复默认布局：删掉全部分组与 placement（节点回到根层默认顺序），一个事务完成。 */
export function resetDeviceFolderLayout(): DeviceFolderLayout {
  const orm = getOrmDb();
  orm.transaction((tx) => {
    tx.delete(deviceFolderPlacements).run();
    tx.delete(deviceFolders).run();
  });
  return getDeviceFolderLayout();
}

/** 旧数据兜底：设备 placement 已不再产生，删设备时仍把可能残留的行清掉。 */
export function removeDeviceFolderPlacementsForDevice(
  deviceId: string,
  db: Pick<ReturnType<typeof getOrmDb>, 'delete'> = getOrmDb()
): void {
  db.delete(deviceFolderPlacements)
    .where(
      and(
        eq(deviceFolderPlacements.nodeId, DEVICE_FOLDER_SELF_NODE_ID),
        eq(deviceFolderPlacements.deviceId, deviceId)
      )
    )
    .run();
}
