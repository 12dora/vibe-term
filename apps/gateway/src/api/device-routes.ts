import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from '../crypto';
import {
  createDevice,
  deleteDevice,
  getAllDevices,
  getDeviceById,
  getDeviceRuntimeStatus,
  reorderDevices,
  updateDevice,
} from '../db';
import { t } from '../i18n';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { pushSupervisor } from '../push/supervisor';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json } from './http';
import { type ApiRoute, route } from './route';
import { handleDeviceTestConnection } from './test-connection';
import { handleTreeOrderApiRequest } from './tree-order';

function shouldReconnectPushSupervisor(existing: Device, updates: Partial<Device>): boolean {
  if (updates.type !== undefined && updates.type !== existing.type) return true;
  if (updates.host !== undefined && updates.host !== existing.host) return true;
  if (updates.port !== undefined && updates.port !== existing.port) return true;
  if (updates.username !== undefined && updates.username !== existing.username) return true;
  if (updates.sshConfigRef !== undefined && updates.sshConfigRef !== existing.sshConfigRef)
    return true;
  if (updates.session !== undefined && updates.session !== existing.session) return true;
  if (updates.authMode !== undefined && updates.authMode !== existing.authMode) return true;
  if (updates.passwordEnc !== undefined) return true;
  if (updates.privateKeyEnc !== undefined) return true;
  if (updates.privateKeyPassphraseEnc !== undefined) return true;

  return false;
}

function enrichDeviceWithRuntime(device: Device): Device & {
  lastSeenAt: string | null;
  lastError: string | null;
  lastErrorType: string | null;
  tmuxAvailable: boolean;
} {
  const status = getDeviceRuntimeStatus(device.id);
  return {
    ...device,
    lastSeenAt: status.lastSeenAt,
    lastError: status.lastError,
    lastErrorType: status.lastErrorType,
    tmuxAvailable: status.tmuxAvailable,
  };
}

async function handleGetDevices(): Promise<Response> {
  const devices = getAllDevices().map(enrichDeviceWithRuntime);
  return json({ devices });
}

async function handleGetDevice(id: string): Promise<Response> {
  const device = getDeviceById(id);
  if (!device) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }
  return json({ device: enrichDeviceWithRuntime(device) });
}

async function handleCreateDevice(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateDeviceRequest;

  if (!body.name || !body.type || !body.authMode) {
    return json({ error: t('apiError.missingFields') }, 400);
  }

  if (body.type === 'ssh' && !body.host && !body.sshConfigRef) {
    return json({ error: t('apiError.sshRequiresHost') }, 400);
  }

  const now = new Date().toISOString();
  const device: Device = {
    id: uuidv4(),
    name: body.name,
    type: body.type,
    host: body.host,
    port: body.port ?? 22,
    username: body.username,
    sshConfigRef: body.sshConfigRef,
    session: body.session ?? 'tmex',
    defaultWorkingDir: body.defaultWorkingDir?.trim() || undefined,
    authMode: body.authMode,
    passwordEnc: body.password ? await encrypt(body.password) : undefined,
    privateKeyEnc: body.privateKey ? await encrypt(body.privateKey) : undefined,
    privateKeyPassphraseEnc: body.privateKeyPassphrase
      ? await encrypt(body.privateKeyPassphrase)
      : undefined,
    // 实际 sort_order 由 createDevice 计算（排到末尾），此处占位
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };

  createDevice(device);
  broadcastSettingsUpdate('devices');
  await pushSupervisor.upsert(device.id);

  return json({ device: getDeviceById(device.id) ?? device }, 201);
}

async function handleUpdateDevice(req: Request, id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const body = (await req.json()) as UpdateDeviceRequest;
  const updates: Partial<Device> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.host !== undefined) updates.host = body.host;
  if (body.port !== undefined) updates.port = body.port;
  if (body.username !== undefined) updates.username = body.username;
  if (body.sshConfigRef !== undefined) updates.sshConfigRef = body.sshConfigRef;
  if (body.session !== undefined) updates.session = body.session;
  if (body.defaultWorkingDir !== undefined)
    updates.defaultWorkingDir = body.defaultWorkingDir.trim() || undefined;
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.password !== undefined) updates.passwordEnc = await encrypt(body.password);
  if (body.privateKey !== undefined) updates.privateKeyEnc = await encrypt(body.privateKey);
  if (body.privateKeyPassphrase !== undefined) {
    updates.privateKeyPassphraseEnc = await encrypt(body.privateKeyPassphrase);
  }

  updateDevice(id, updates);
  broadcastSettingsUpdate('devices');

  if (shouldReconnectPushSupervisor(existing, updates)) {
    await pushSupervisor.reconnect(id);
  } else if (
    updates.defaultWorkingDir !== undefined &&
    updates.defaultWorkingDir !== existing.defaultWorkingDir
  ) {
    pushSupervisor.updateDefaultWorkingDir(id, updates.defaultWorkingDir);
  }

  const device = getDeviceById(id);
  return json({ device });
}

async function handleReorderDevices(req: Request): Promise<Response> {
  const body = (await req.json()) as { deviceIds?: unknown };
  if (!Array.isArray(body.deviceIds) || body.deviceIds.some((id) => typeof id !== 'string')) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  reorderDevices(body.deviceIds as string[]);
  broadcastSettingsUpdate('devices');
  return json({ devices: getAllDevices().map(enrichDeviceWithRuntime) });
}

async function handleDeleteDevice(id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  deleteDevice(id);
  broadcastSettingsUpdate('devices');
  pushSupervisor.remove(id);
  connectionAlertNotifier.clear(id);
  return json({ success: true });
}

async function handleTestConnection(id: string): Promise<Response> {
  return handleDeviceTestConnection(id);
}

export const deviceRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/devices', handler: () => handleGetDevices() }),
  route({ method: 'POST', path: '/api/devices', handler: (req) => handleCreateDevice(req) }),
  route({
    method: 'PUT',
    path: '/api/devices/order',
    handler: (req) => handleReorderDevices(req),
  }),
  route({
    method: 'GET',
    path: '/api/devices/:id',
    handler: (_req, params) => handleGetDevice(params.id),
  }),
  route({
    method: 'PATCH',
    path: '/api/devices/:id',
    handler: (req, params) => handleUpdateDevice(req, params.id),
  }),
  route({
    method: 'DELETE',
    path: '/api/devices/:id',
    handler: (_req, params) => handleDeleteDevice(params.id),
  }),
  route({
    method: 'POST',
    path: '/api/devices/:id/test-connection',
    handler: (_req, params) => handleTestConnection(params.id),
  }),
  route({
    method: '*',
    path: '/api/devices/*',
    handler: (req, _params, ctx) => handleTreeOrderApiRequest(req, ctx.path),
  }),
];
