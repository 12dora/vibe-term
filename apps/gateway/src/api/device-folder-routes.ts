import {
  type DeviceFolderLayout,
  type DeviceFolderNameError,
  type DeviceFolderPlacement,
  type UpdateDeviceFolderLayoutRequest,
  isDeviceFolderLayoutValid,
  validateDeviceFolderName,
} from '@tmex/shared';
import {
  createDeviceFolder,
  deleteDeviceFolder,
  getDeviceFolderById,
  getDeviceFolderLayout,
  replaceDeviceFolderLayout,
  resetDeviceFolderLayout,
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

/** 分组只有一层：请求里带了非 null 的 parentId 就是在试图嵌套 */
function requestsNesting(body: Record<string, unknown>): boolean {
  return body.parentId !== undefined && body.parentId !== null;
}

function handleGetLayout(): Response {
  return json(getDeviceFolderLayout());
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || typeof body.name !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (requestsNesting(body)) return json({ error: t('apiError.folderLayoutInvalid') }, 400);
  const validated = validateDeviceFolderName(body.name);
  if (!validated.ok) return folderNameError(validated.error);

  const folder = createDeviceFolder({ id: crypto.randomUUID(), name: validated.name });
  broadcastSettingsUpdate('device-folders');
  return json({ folder }, 201);
}

async function handleUpdate(req: Request, id: string): Promise<Response> {
  const existing = getDeviceFolderById(id);
  if (!existing) return json({ error: t('apiError.folderNotFound') }, 404);

  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);
  if (requestsNesting(body)) return json({ error: t('apiError.folderLayoutInvalid') }, 400);

  const patch: { name?: string; sortOrder?: number } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return json({ error: t('apiError.invalidRequest') }, 400);
    const validated = validateDeviceFolderName(body.name);
    if (!validated.ok) return folderNameError(validated.error);
    patch.name = validated.name;
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

type LayoutFolder = UpdateDeviceFolderLayoutRequest['folders'][number];

/** 结构不对返回 null；带非 null parentId（嵌套）返回 'nested' */
function parseLayoutFolder(raw: unknown): LayoutFolder | 'nested' | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id) return null;
  if (typeof item.sortOrder !== 'number' || !Number.isInteger(item.sortOrder)) return null;
  if (requestsNesting(item)) return 'nested';
  return { id: item.id, sortOrder: item.sortOrder };
}

/**
 * placement 只认节点：旧客户端可能仍带 `kind` / `deviceId`，`kind` 只允许 'node'、
 * `deviceId` 只允许空；带设备的 placement 一律视为布局非法。
 */
function parsePlacement(raw: unknown): DeviceFolderPlacement | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind !== undefined && item.kind !== 'node') return null;
  if (item.deviceId !== undefined && item.deviceId !== null) return null;
  if (typeof item.nodeId !== 'string' || !item.nodeId) return null;
  if (typeof item.sortOrder !== 'number' || !Number.isInteger(item.sortOrder)) return null;
  if (item.folderId !== null && typeof item.folderId !== 'string') return null;
  return { nodeId: item.nodeId, folderId: item.folderId, sortOrder: item.sortOrder };
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

  const folders: LayoutFolder[] = [];
  for (const item of body.folders) {
    const parsed = parseLayoutFolder(item);
    if (parsed === null) return json({ error: t('apiError.invalidRequest') }, 400);
    if (parsed === 'nested') return json({ error: t('apiError.folderLayoutInvalid') }, 400);
    folders.push(parsed);
  }

  const currentIds = getDeviceFolderLayout().folders.map((folder) => folder.id);
  if (
    !sameIdSet(
      currentIds,
      folders.map((folder) => folder.id)
    )
  ) {
    return json({ error: t('apiError.folderLayoutInvalid') }, 400);
  }

  const placements: DeviceFolderPlacement[] = [];
  for (const item of body.placements) {
    const parsed = parsePlacement(item);
    if (!parsed) return json({ error: t('apiError.folderLayoutInvalid') }, 400);
    placements.push(parsed);
  }
  if (!isDeviceFolderLayoutValid({ folders, placements })) {
    return json({ error: t('apiError.folderLayoutInvalid') }, 400);
  }

  const layout: DeviceFolderLayout = replaceDeviceFolderLayout({ folders, placements });
  broadcastSettingsUpdate('device-folders');
  return json(layout);
}

function handleReset(): Response {
  const layout = resetDeviceFolderLayout();
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
  route({ method: 'POST', path: '/api/device-folders/reset', handler: () => handleReset() }),
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
