import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import type { Server } from 'bun';
import { createDevice, updateDeviceRuntimeStatus } from '../db';
import { getSqliteClient } from '../db/client';
import * as devicesDb from '../db/devices';
import { runMigrations } from '../db/migrate';
import { handleApiRequest } from './index';

const PREFIX = 'r3-api-dev-';
const fakeServer = {} as Server<unknown>;

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    const id = `${PREFIX}${String(i).padStart(3, '0')}`;
    createDevice({
      id,
      name: `r3-${i}`,
      type: 'local',
      session: 'tmex',
      authMode: 'auto',
      sortOrder: i,
      createdAt: now,
      updatedAt: now,
    });
  }
  updateDeviceRuntimeStatus(`${PREFIX}000`, {
    lastSeenAt: '2026-06-13T12:00:00.000Z',
    tmuxAvailable: true,
    lastError: 'late',
    lastErrorType: 'ssh',
  });
});

async function captureSql<T>(fn: () => T | Promise<T>): Promise<{ result: T; sqls: string[] }> {
  const db = getSqliteClient();
  const orig = db.prepare.bind(db);
  const sqls: string[] = [];
  db.prepare = ((sql: string) => {
    sqls.push(sql);
    return orig(sql);
  }) as typeof db.prepare;
  try {
    return { result: await fn(), sqls };
  } finally {
    db.prepare = orig;
  }
}

describe('GET /api/devices query batching', () => {
  test('100 台设备恰好 1 次查询，缺状态行用默认值，shape 含 runtime 字段', async () => {
    const statusSpy = spyOn(devicesDb, 'getDeviceRuntimeStatus');
    const { result, sqls } = await captureSql(() =>
      handleApiRequest(new Request('http://localhost/api/devices'), fakeServer)
    );
    const response = await result;
    expect(response.status).toBe(200);
    expect(sqls.filter((sql) => /^\s*select\b/i.test(sql)).length).toBe(1);
    expect(statusSpy).toHaveBeenCalledTimes(0);
    statusSpy.mockRestore();

    const body = (await response.json()) as {
      devices: Array<
        Device & {
          lastSeenAt: string | null;
          lastError: string | null;
          lastErrorType: string | null;
          tmuxAvailable: boolean;
        }
      >;
    };
    const ours = body.devices.filter((d) => d.id.startsWith(PREFIX));
    expect(ours).toHaveLength(100);
    const first = ours.find((d) => d.id === `${PREFIX}000`);
    const rest = ours.find((d) => d.id === `${PREFIX}001`);
    expect(first?.lastSeenAt).toBe('2026-06-13T12:00:00.000Z');
    expect(first?.tmuxAvailable).toBe(true);
    expect(first?.lastError).toBe('late');
    expect(first?.lastErrorType).toBe('ssh');
    expect(rest?.lastSeenAt).toBeNull();
    expect(rest?.tmuxAvailable).toBe(false);
    expect(rest?.lastError).toBeNull();
    expect(rest?.lastErrorType).toBeNull();
  });

  test('reorder 响应同样批量带 runtime 状态且恰好 1 次 SELECT', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${PREFIX}${String(i).padStart(3, '0')}`);
    const statusSpy = spyOn(devicesDb, 'getDeviceRuntimeStatus');
    const { result, sqls } = await captureSql(() =>
      handleApiRequest(
        new Request('http://localhost/api/devices/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceIds: ids }),
        }),
        fakeServer
      )
    );
    const response = await result;
    expect(response.status).toBe(200);
    const selects = sqls.filter((sql) => /^\s*select\b/i.test(sql));
    expect(selects.length).toBe(1);
    expect(statusSpy).toHaveBeenCalledTimes(0);
    statusSpy.mockRestore();
    const body = (await response.json()) as {
      devices: Array<{ id: string; tmuxAvailable: boolean }>;
    };
    expect(body.devices.filter((d) => d.id.startsWith(PREFIX))).toHaveLength(100);
  });
});
