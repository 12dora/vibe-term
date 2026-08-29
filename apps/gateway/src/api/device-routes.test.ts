import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import * as devicesDb from '../db/devices';
import { pushSupervisor } from '../push/supervisor';
import { deviceRoutes } from './device-routes';
import { dispatchRoutes } from './route';

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length > 0) {
    spies.pop()?.mockRestore();
  }
});

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

function dispatchDevice(req: Request) {
  const path = new URL(req.url).pathname;
  return dispatchRoutes(req, path, deviceRoutes, { server: {} as never, path });
}

function callApi(method: string, path: string, body?: unknown): Response | Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = dispatchDevice(req);
  if (!response) {
    throw new Error(`no handler matched: ${method} ${path}`);
  }
  return response;
}

const existing: Device = {
  id: 'dev-patch',
  name: 'box',
  type: 'ssh',
  host: 'old.example',
  port: 22,
  username: 'root',
  sshConfigRef: undefined,
  session: 'tmex',
  authMode: 'password',
  defaultWorkingDir: '/old',
  sortOrder: 0,
  createdAt: 't0',
  updatedAt: 't0',
};

function stubDevice(device: Device | null = existing) {
  track(spyOn(devicesDb, 'getDeviceById').mockReturnValue(device));
  track(spyOn(devicesDb, 'updateDevice').mockImplementation(() => {}));
  track(spyOn(pushSupervisor, 'reconnect').mockResolvedValue(undefined));
  track(spyOn(pushSupervisor, 'updateDefaultWorkingDir').mockImplementation(() => {}));
}

describe('PATCH /api/devices/:id', () => {
  test('未知设备返回 404', async () => {
    stubDevice(null);
    const response = await callApi('PATCH', '/api/devices/missing', { name: 'x' });
    expect(response.status).toBe(404);
  });

  test('改名不触发 reconnect 或 working-dir 更新', async () => {
    stubDevice();
    const response = await callApi('PATCH', `/api/devices/${existing.id}`, { name: 'renamed' });
    expect(response.status).toBe(200);
    expect(pushSupervisor.reconnect).not.toHaveBeenCalled();
    expect(pushSupervisor.updateDefaultWorkingDir).not.toHaveBeenCalled();
  });

  test('连接字段变化触发 reconnect', async () => {
    stubDevice();
    const response = await callApi('PATCH', `/api/devices/${existing.id}`, {
      host: 'new.example',
    });
    expect(response.status).toBe(200);
    expect(pushSupervisor.reconnect).toHaveBeenCalledWith(existing.id);
    expect(pushSupervisor.updateDefaultWorkingDir).not.toHaveBeenCalled();
  });

  test('仅 defaultWorkingDir 变化时更新 supervisor 而不 reconnect', async () => {
    stubDevice();
    const response = await callApi('PATCH', `/api/devices/${existing.id}`, {
      defaultWorkingDir: ' /work ',
    });
    expect(response.status).toBe(200);
    expect(pushSupervisor.reconnect).not.toHaveBeenCalled();
    expect(pushSupervisor.updateDefaultWorkingDir).toHaveBeenCalledWith(existing.id, '/work');
  });

  test('空白 defaultWorkingDir 写成 undefined 且不通知 supervisor', async () => {
    stubDevice();
    const response = await callApi('PATCH', `/api/devices/${existing.id}`, {
      defaultWorkingDir: '  ',
    });
    expect(response.status).toBe(200);
    expect(devicesDb.updateDevice).toHaveBeenCalledWith(existing.id, {
      defaultWorkingDir: undefined,
    });
    expect(pushSupervisor.reconnect).not.toHaveBeenCalled();
    expect(pushSupervisor.updateDefaultWorkingDir).not.toHaveBeenCalled();
  });

  test('密码变化触发 reconnect 且优先于 working-dir 更新', async () => {
    stubDevice();
    const response = await callApi('PATCH', `/api/devices/${existing.id}`, {
      password: 'secret',
      defaultWorkingDir: '/work',
    });
    expect(response.status).toBe(200);
    expect(pushSupervisor.reconnect).toHaveBeenCalledWith(existing.id);
    expect(pushSupervisor.updateDefaultWorkingDir).not.toHaveBeenCalled();
  });
});
