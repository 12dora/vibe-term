import type { CreateDeviceRequest, Device } from '@tmex/shared';
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
import {
  type DeviceUpdateDraft,
  nextDevicePushAction,
  parseDeviceUpdateFields,
} from './device-patch';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';
import { handleDeviceTestConnection } from './test-connection';
import { treeOrderRoutes } from './tree-order';

async function encryptSecretFields(draft: DeviceUpdateDraft): Promise<Partial<Device>> {
  const { password, privateKey, privateKeyPassphrase, ...rest } = draft;
  const updates: Partial<Device> = { ...rest };
  if (password !== undefined) updates.passwordEnc = await encrypt(password);
  if (privateKey !== undefined) updates.privateKeyEnc = await encrypt(privateKey);
  if (privateKeyPassphrase !== undefined) {
    updates.privateKeyPassphraseEnc = await encrypt(privateKeyPassphrase);
  }
  return updates;
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

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = parseDeviceUpdateFields(raw);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const updates = await encryptSecretFields(parsed.fields);
  updateDevice(id, updates);
  broadcastSettingsUpdate('devices');

  const action = nextDevicePushAction(existing, updates);
  if (action.type === 'reconnect') {
    await pushSupervisor.reconnect(id);
  } else if (action.type === 'workingDir') {
    pushSupervisor.updateDefaultWorkingDir(id, action.dir);
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
  broadcastSettingsUpdate('device-folders');
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
  ...treeOrderRoutes,
];
