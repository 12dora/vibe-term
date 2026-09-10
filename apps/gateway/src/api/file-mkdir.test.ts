import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { t } from '../i18n';
import { fileTransferRoutes } from './file-transfer-routes';
import { dispatchRoutes } from './route';

beforeAll(() => {
  runMigrations();
});

const createdRootIds: string[] = [];
const sandboxes: string[] = [];

afterEach(() => {
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

function makeDevice(id: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: `dev-${id}`,
    type: 'local',
    session: 'vibeterm',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function sandboxRoot(): { dir: string; rootId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-mkdir-'));
  sandboxes.push(dir);
  const deviceId = `mkdir-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(deviceId));
  const root = createFileRoot({ deviceId, path: dir });
  createdRootIds.push(root.id);
  return { dir, rootId: root.id };
}

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request('http://localhost/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, fileTransferRoutes, { path: pathname });
  if (!response) throw new Error('no route matched POST /api/files/mkdir');
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('POST /api/files/mkdir', () => {
  test('creates a directory under the file root', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'new-folder');

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(200);
    expect(json).toEqual({ path, created: true });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test('recursive true creates missing parents (mkdir -p)', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'a/b/c');

    const { status, json } = await call({ rootId, path, recursive: true });

    expect(status).toBe(200);
    expect(json).toEqual({ path, created: true });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(join(dir, 'a/b')).isDirectory()).toBe(true);
  });

  test('idempotent: existing directory returns created false', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'already');
    mkdirSync(path);

    const first = await call({ rootId, path });
    const second = await call({ rootId, path });

    expect(first).toEqual({ status: 200, json: { path, created: false } });
    expect(second).toEqual({ status: 200, json: { path, created: false } });
  });

  test('file in the way returns 409 not_a_directory', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'a-file');
    writeFileSync(path, 'nope');

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(409);
    expect(json).toEqual({ error: 'not_a_directory', code: 'not_a_directory' });
    expect(statSync(path).isFile()).toBe(true);
  });

  test('path outside the root returns 403 outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = join(dir, '..', 'escape-mkdir');

    const { status, json } = await call({ rootId, path: outside });

    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
    expect(existsSync(outside)).toBe(false);
  });

  test('disabled root returns 403 root_disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-mkdir-dis-'));
    sandboxes.push(dir);
    const deviceId = `mkdir-dis-${crypto.randomUUID().slice(0, 8)}`;
    createDevice(makeDevice(deviceId));
    const root = createFileRoot({ deviceId, path: dir, enabled: false });
    createdRootIds.push(root.id);

    const { status, json } = await call({ rootId: root.id, path: join(dir, 'x') });

    expect(status).toBe(403);
    expect(json).toEqual({ error: 'root_disabled', code: 'root_disabled' });
  });

  test('.. escaping the root is rejected', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = `${dir}/foo/../../outside`;

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
  });

  test('missing parent without recursive returns 404 not_found', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'missing', 'child');

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(404);
    expect(json).toEqual({ error: 'not_found', code: 'not_found' });
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });

  test('permission denied on unwritable parent returns 403', async () => {
    const { dir, rootId } = sandboxRoot();
    const locked = join(dir, 'locked');
    mkdirSync(locked, { mode: 0o555 });
    try {
      const { status, json } = await call({ rootId, path: join(locked, 'child') });
      expect(status).toBe(403);
      expect(json).toEqual({ error: 'permission_denied', code: 'permission_denied' });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('rejects JSON null and array bodies', async () => {
    for (const body of [null, []]) {
      const { status, json } = await call(body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: t('apiError.invalidRequest') });
    }
  });

  test('unknown root returns 404 root_not_found', async () => {
    const { status, json } = await call({ rootId: 'no-such-root', path: '/tmp/x' });
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'root_not_found', code: 'root_not_found' });
  });

  test('normalizes . and in-root .. before creating', async () => {
    const { dir, rootId } = sandboxRoot();
    mkdirSync(join(dir, 'keep'));
    const path = join(dir, 'keep', '.', '..', 'normalized');

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(200);
    expect(json).toEqual({ path: join(dir, 'normalized'), created: true });
    expect(statSync(join(dir, 'normalized')).isDirectory()).toBe(true);
  });
});
