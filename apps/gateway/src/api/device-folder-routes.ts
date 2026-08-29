import {
  type DeviceFolderLayout,
  type DeviceFolderNameError,
  type DeviceFolderPlacement,
  type UpdateDeviceFolderLayoutRequest,
  deviceFolderItemKey,
  isFolderForestValid,
  validateDeviceFolderName,
  wouldCreateFolderCycle,
} from '@tmex/shared';
import {
  createDeviceFolder,
  deleteDeviceFolder,
  getDeviceFolderById,
  getDeviceFolderLayout,
  replaceDeviceFolderLayout,
  updateDeviceFolder,
} from '../db';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function folderNameError(error: DeviceFolderNameError): Response {
  if (error === 'empty') return json({ error: t('apiError.folderNameRequired') }, 400);
  return json({ error: t('apiError.folderNameTooLong') }, 400);
}

function parseParentId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'string') return { ok: true, value: raw };
  return { ok: false };
}

function handleGetLayout(): Response {
  return json(getDeviceFolderLayout());
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || typeof body.name !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const validated = validateDeviceFolderName(body.name);
  if (!validated.ok) return folderNameError(validated.error);

  let parentId: string | null = null;
  if (body.parentId !== undefined) {
    const parsed = parseParentId(body.parentId);
    if (!parsed.ok) return json({ error: t('apiError.invalidRequest') }, 400);
    parentId = parsed.value;
    if (parentId !== null && !getDeviceFolderById(parentId)) {
      return json({ error: t('apiError.folderNotFound') }, 404);
    }
  }

  const folder = createDeviceFolder({
    id: crypto.randomUUID(),
    name: validated.name,
    parentId,
  });
  broadcastSettingsUpdate('device-folders');
  return json({ folder }, 201);
}

async function handleUpdate(req: Request, id: string): Promise<Response> {
  const existing = getDeviceFolderById(id);
  if (!existing) return json({ error: t('apiError.folderNotFound') }, 404);

  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);

  const patch: { name?: string; parentId?: string | null; sortOrder?: number } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return json({ error: t('apiError.invalidRequest') }, 400);
    const validated = validateDeviceFolderName(body.name);
    if (!validated.ok) return folderNameError(validated.error);
    patch.name = validated.name;
  }
  if (body.parentId !== undefined) {
    const parsed = parseParentId(body.parentId);
    if (!parsed.ok) return json({ error: t('apiError.invalidRequest') }, 400);
    if (parsed.value !== null && !getDeviceFolderById(parsed.value)) {
      return json({ error: t('apiError.folderNotFound') }, 404);
    }
    if (wouldCreateFolderCycle(getDeviceFolderLayout().folders, id, parsed.value)) {
      return json({ error: t('apiError.folderCycle') }, 400);
    }
    patch.parentId = parsed.value;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    patch.sortOrder = body.sortOrder;
  }

  const folder = updateDeviceFolder(id, patch);
  if (!folder) return json({ error: t('apiError.folderNotFound') }, 404);
  broadcastSettingsUpdate('device-folders');
  return json({ folder });
}

function handleDelete(id: string): Response {
  if (!deleteDeviceFolder(id)) return json({ error: t('apiError.folderNotFound') }, 404);
  broadcastSettingsUpdate('device-folders');
  return json({ success: true });
}

function parseLayoutFolder(
  raw: unknown
): Pick<
  UpdateDeviceFolderLayoutRequest['folders'][number],
  'id' | 'parentId' | 'sortOrder'
> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) return null;
  if (item.parentId !== null && typeof item.parentId !== 'string') return null;
  if (typeof item.sortOrder !== 'number' || !Number.isInteger(item.sortOrder)) return null;
  return { id: item.id, parentId: item.parentId, sortOrder: item.sortOrder };
}

function parsePlacement(raw: unknown, folderIds: Set<string>): DeviceFolderPlacement | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind !== 'node' && item.kind !== 'device') return null;
  if (typeof item.nodeId !== 'string' || !item.nodeId) return null;
  if (typeof item.sortOrder !== 'number' || !Number.isInteger(item.sortOrder)) return null;
  if (item.folderId !== null && typeof item.folderId !== 'string') return null;
  if (item.folderId !== null && !folderIds.has(item.folderId)) return null;
  const folderId = item.folderId;

  if (item.kind === 'node') {
    if (item.deviceId !== null && item.deviceId !== undefined) return null;
    return {
      kind: 'node',
      nodeId: item.nodeId,
      deviceId: null,
      folderId,
      sortOrder: item.sortOrder,
    };
  }
  if (typeof item.deviceId !== 'string' || !item.deviceId) return null;
  return {
    kind: 'device',
    nodeId: item.nodeId,
    deviceId: item.deviceId,
    folderId,
    sortOrder: item.sortOrder,
  };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  if (leftIds.size !== left.length || rightIds.size !== right.length) return false;
  for (const id of rightIds) {
    if (!leftIds.has(id)) return false;
  }
  return true;
}

async function handleReplaceLayout(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || !Array.isArray(body.folders) || !Array.isArray(body.placements)) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const folders: UpdateDeviceFolderLayoutRequest['folders'] = [];
  for (const item of body.folders) {
    const parsed = parseLayoutFolder(item);
    if (!parsed) return json({ error: t('apiError.invalidRequest') }, 400);
    folders.push(parsed);
  }

  const currentIds = getDeviceFolderLayout().folders.map((folder) => folder.id);
  const requestIds = folders.map((folder) => folder.id);
  if (!sameIdSet(currentIds, requestIds)) {
    return json({ error: t('apiError.folderLayoutInvalid') }, 400);
  }
  if (!isFolderForestValid(folders)) {
    return json({ error: t('apiError.folderCycle') }, 400);
  }

  const folderIds = new Set(requestIds);
  const placements: DeviceFolderPlacement[] = [];
  const seenKeys = new Set<string>();
  for (const item of body.placements) {
    const parsed = parsePlacement(item, folderIds);
    if (!parsed) return json({ error: t('apiError.folderLayoutInvalid') }, 400);
    const key = deviceFolderItemKey(parsed);
    if (seenKeys.has(key)) return json({ error: t('apiError.folderLayoutInvalid') }, 400);
    seenKeys.add(key);
    placements.push(parsed);
  }

  const layout: DeviceFolderLayout = replaceDeviceFolderLayout({ folders, placements });
  broadcastSettingsUpdate('device-folders');
  return json(layout);
}

export const deviceFolderRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/device-folders', handler: () => handleGetLayout() }),
  route({ method: 'POST', path: '/api/device-folders', handler: (req) => handleCreate(req) }),
  route({
    method: 'PUT',
    path: '/api/device-folders/layout',
    handler: (req) => handleReplaceLayout(req),
  }),
  route({
    method: 'PATCH',
    path: '/api/device-folders/:id',
    handler: (req, params) => handleUpdate(req, params.id),
  }),
  route({
    method: 'DELETE',
    path: '/api/device-folders/:id',
    handler: (_req, params) => handleDelete(params.id),
  }),
];
