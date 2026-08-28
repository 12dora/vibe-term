import type { FileRootDto, UpdateFileRootRequest } from '@tmex/shared';
import { getDeviceById } from '../db';
import {
  type FileRootRecord,
  createFileRoot,
  deleteFileRoot,
  getFileRootById,
  getFileRoots,
  updateFileRoot,
} from '../db/file-roots';
import { t } from '../i18n';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function rootDisplayName(p: string): string {
  if (p === '/') return '/';
  const i = p.replace(/\/$/, '').lastIndexOf('/');
  const base = i >= 0 ? p.replace(/\/$/, '').slice(i + 1) : p;
  return base || p;
}

function toRootDto(root: FileRootRecord): FileRootDto {
  const device = getDeviceById(root.deviceId);
  return {
    id: root.id,
    deviceId: root.deviceId,
    deviceName: device?.name ?? null,
    deviceType: device?.type ?? null,
    path: root.path,
    name: rootDisplayName(root.path),
    enabled: root.enabled,
    sortOrder: root.sortOrder,
  };
}

function handleListRoots(): Response {
  return json({ roots: getFileRoots().map(toRootDto) });
}

async function handleCreateRoot(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!deviceId || !getDeviceById(deviceId)) {
    return json({ error: t('apiError.fileRootDeviceInvalid') }, 400);
  }
  if (!path || !path.startsWith('/')) {
    return json({ error: t('apiError.fileRootInvalid') }, 400);
  }

  const existing = getFileRoots().find((r) => r.deviceId === deviceId && r.path === path);
  if (existing) {
    return json({ error: t('apiError.fileRootDuplicate') }, 400);
  }

  const record = createFileRoot({
    deviceId,
    path,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
  });
  broadcastSettingsUpdate('file-roots');
  return json({ root: toRootDto(record) }, 201);
}

async function handleUpdateRoot(req: Request, id: string): Promise<Response> {
  const existing = getFileRootById(id);
  if (!existing) return json({ error: t('apiError.notFound') }, 404);

  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);

  const updates: UpdateFileRootRequest = {};
  if (body.path !== undefined) {
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path || !path.startsWith('/')) return json({ error: t('apiError.fileRootInvalid') }, 400);
    const dup = getFileRoots().find(
      (r) => r.id !== id && r.deviceId === existing.deviceId && r.path === path
    );
    if (dup) return json({ error: t('apiError.fileRootDuplicate') }, 400);
    updates.path = path;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      return json({ error: t('apiError.invalidRequest') }, 400);
    updates.enabled = body.enabled;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number')
      return json({ error: t('apiError.invalidRequest') }, 400);
    updates.sortOrder = body.sortOrder;
  }

  const updated = updateFileRoot(id, updates);
  if (!updated) return json({ error: t('apiError.notFound') }, 404);
  broadcastSettingsUpdate('file-roots');
  return json({ root: toRootDto(updated) });
}

function handleDeleteRoot(id: string): Response {
  const okDelete = deleteFileRoot(id);
  if (!okDelete) return json({ error: t('apiError.notFound') }, 404);
  broadcastSettingsUpdate('file-roots');
  return json({ success: true });
}

export const fileRootRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/files/roots', handler: () => handleListRoots() }),
  route({ method: 'POST', path: '/api/files/roots', handler: (req) => handleCreateRoot(req) }),
  route({
    method: 'PATCH',
    path: '/api/files/roots/:id',
    handler: (req, params) => handleUpdateRoot(req, decodeURIComponent(params.id)),
  }),
  route({
    method: 'DELETE',
    path: '/api/files/roots/:id',
    handler: (_req, params) => handleDeleteRoot(decodeURIComponent(params.id)),
  }),
];
