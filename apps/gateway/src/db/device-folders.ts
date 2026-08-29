import {
  DEVICE_FOLDER_SELF_NODE_ID,
  type DeviceFolder,
  type DeviceFolderLayout,
  type DeviceFolderPlacement,
  type UpdateDeviceFolderLayoutRequest,
  deviceFolderItemKey,
  normalizeFolderLayoutOrder,
  reparentOnFolderDelete,
} from '@tmex/shared';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { deviceFolderPlacements, deviceFolders } from './schema';

function toFolder(row: typeof deviceFolders.$inferSelect): DeviceFolder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId ?? null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlacement(row: typeof deviceFolderPlacements.$inferSelect): DeviceFolderPlacement {
  return {
    kind: row.kind === 'device' ? 'device' : 'node',
    nodeId: row.nodeId,
    deviceId: row.deviceId ?? null,
    folderId: row.folderId ?? null,
    sortOrder: row.sortOrder,
  };
}

function maxSortOrderForParent(tx: ReturnType<typeof getOrmDb>, parentId: string | null): number {
  const row =
    parentId === null
      ? tx
          .select({ value: max(deviceFolders.sortOrder) })
          .from(deviceFolders)
          .where(isNull(deviceFolders.parentId))
          .get()
      : tx
          .select({ value: max(deviceFolders.sortOrder) })
          .from(deviceFolders)
          .where(eq(deviceFolders.parentId, parentId))
          .get();
  return row?.value ?? -1;
}

export function getDeviceFolderLayout(): DeviceFolderLayout {
  const orm = getOrmDb();
  const folders = orm
    .select()
    .from(deviceFolders)
    .orderBy(asc(deviceFolders.parentId), asc(deviceFolders.sortOrder))
    .all()
    .map(toFolder);
  const placements = orm
    .select()
    .from(deviceFolderPlacements)
    .orderBy(asc(deviceFolderPlacements.folderId), asc(deviceFolderPlacements.sortOrder))
    .all()
    .map(toPlacement);
  return { folders, placements };
}

export function getDeviceFolderById(id: string): DeviceFolder | null {
  const orm = getOrmDb();
  const row = orm.select().from(deviceFolders).where(eq(deviceFolders.id, id)).get();
  return row ? toFolder(row) : null;
}

export function createDeviceFolder(input: {
  id: string;
  name: string;
  parentId: string | null;
}): DeviceFolder {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const sortOrder = maxSortOrderForParent(orm, input.parentId) + 1;
  const row = {
    id: input.id,
    name: input.name,
    parentId: input.parentId,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  orm.insert(deviceFolders).values(row).run();
  return toFolder(row);
}

export function updateDeviceFolder(
  id: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number }
): DeviceFolder | null {
  const current = getDeviceFolderById(id);
  if (!current) return null;

  const orm = getOrmDb();
  const nextParentId = patch.parentId !== undefined ? patch.parentId : current.parentId;
  const parentChanged = nextParentId !== current.parentId;
  let nextSortOrder = current.sortOrder;
  if (patch.sortOrder !== undefined) {
    nextSortOrder = patch.sortOrder;
  } else if (parentChanged) {
    nextSortOrder = maxSortOrderForParent(orm, nextParentId) + 1;
  }

  const now = new Date().toISOString();
  const next: DeviceFolder = {
    ...current,
    name: patch.name ?? current.name,
    parentId: nextParentId,
    sortOrder: nextSortOrder,
    updatedAt: now,
  };
  orm
    .update(deviceFolders)
    .set({
      name: next.name,
      parentId: next.parentId,
      sortOrder: next.sortOrder,
      updatedAt: now,
    })
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
        .set({
          parentId: folder.parentId,
          sortOrder: folder.sortOrder,
          updatedAt: now,
        })
        .where(eq(deviceFolders.id, folder.id))
        .run();
    }
    for (const placement of next.placements) {
      tx.update(deviceFolderPlacements)
        .set({
          folderId: placement.folderId,
          sortOrder: placement.sortOrder,
          updatedAt: now,
        })
        .where(eq(deviceFolderPlacements.itemKey, deviceFolderItemKey(placement)))
        .run();
    }
    tx.delete(deviceFolders).where(eq(deviceFolders.id, id)).run();
  });
  return true;
}

export function replaceDeviceFolderLayout(
  layout: UpdateDeviceFolderLayoutRequest
): DeviceFolderLayout {
  const current = getDeviceFolderLayout();
  const byId = new Map(current.folders.map((folder) => [folder.id, folder]));
  const now = new Date().toISOString();
  const folders: DeviceFolder[] = layout.folders.map((item) => {
    const prev = byId.get(item.id);
    return {
      id: item.id,
      name: prev?.name ?? '',
      parentId: item.parentId,
      sortOrder: item.sortOrder,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
  });
  const normalized = normalizeFolderLayoutOrder({
    folders,
    placements: layout.placements.map((placement) => ({
      ...placement,
      deviceId: placement.kind === 'node' ? null : placement.deviceId,
    })),
  });
  const orm = getOrmDb();
  orm.transaction((tx) => {
    for (const folder of normalized.folders) {
      tx.update(deviceFolders)
        .set({
          parentId: folder.parentId,
          sortOrder: folder.sortOrder,
          updatedAt: now,
        })
        .where(eq(deviceFolders.id, folder.id))
        .run();
    }
    tx.delete(deviceFolderPlacements).run();
    for (const placement of normalized.placements) {
      tx.insert(deviceFolderPlacements)
        .values({
          itemKey: deviceFolderItemKey(placement),
          kind: placement.kind,
          nodeId: placement.nodeId,
          deviceId: placement.deviceId,
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

export function removeDeviceFolderPlacementsForDevice(deviceId: string): void {
  const orm = getOrmDb();
  orm
    .delete(deviceFolderPlacements)
    .where(
      and(
        eq(deviceFolderPlacements.nodeId, DEVICE_FOLDER_SELF_NODE_ID),
        eq(deviceFolderPlacements.deviceId, deviceId)
      )
    )
    .run();
}
