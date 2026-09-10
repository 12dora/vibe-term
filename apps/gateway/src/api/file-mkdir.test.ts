import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, FileStatResponse } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import * as deviceStorage from '../files/device-storage';
import { t } from '../i18n';
import * as destRemote from '../transfer/dest-remote';
import { fileTransferRoutes } from './file-transfer-routes';
import { dispatchRoutes } from './route';

beforeAll(() => {
  runMigrations();
});

const createdRootIds: string[] = [];
const sandboxes: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

function makeDevice(id: string, type: Device['type'] = 'local'): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: `dev-${id}`,
    type,
    host: type === 'ssh' ? '127.0.0.1' : undefined,
    username: type === 'ssh' ? 'nobody' : undefined,
    session: type === 'local' ? 'vibeterm' : undefined,
    authMode: type === 'ssh' ? 'agent' : 'auto',
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

function sshRoot(path = '/remote/root'): { rootId: string; path: string } {
  const deviceId = `mkdir-ssh-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(deviceId, 'ssh'));
  const root = createFileRoot({ deviceId, path });
  createdRootIds.push(root.id);
  return { rootId: root.id, path };
}

function fakeStat(
  path: string,
  type: FileStatResponse['type'],
  isSymlink = type === 'symlink'
): FileStatResponse {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1) || path,
    type,
    category: type === 'dir' ? 'directory' : 'other',
    size: 0,
    modifiedAt: null,
    mime: null,
    isSymlink,
  };
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
    const prev = process.umask(0o077);
    try {
      const { status, json } = await call({ rootId, path });

      expect(status).toBe(200);
      expect(json).toEqual({ path, created: true });
      expect(statSync(path).isDirectory()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prev);
    }
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

  test('path equal to the root is idempotent created false', async () => {
    const { dir, rootId } = sandboxRoot();
    const { status, json } = await call({ rootId, path: dir });
    expect(status).toBe(200);
    expect(json).toEqual({ path: dir, created: false });
  });

  test('trailing slash is normalized before creating', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'slashdir');
    const { status, json } = await call({ rootId, path: `${path}/` });
    expect(status).toBe(200);
    expect(json).toEqual({ path, created: true });
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test('file in the way returns 400 not_a_directory', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'a-file');
    writeFileSync(path, 'nope');

    const { status, json } = await call({ rootId, path });

    expect(status).toBe(400);
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

  test('symlink intermediate component returns 403 outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = mkdtempSync(join(tmpdir(), 'vibeterm-mkdir-out-'));
    sandboxes.push(outside);
    symlinkSync(outside, join(dir, 'link'));

    const { status, json } = await call({ rootId, path: join(dir, 'link', 'child') });

    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
    expect(existsSync(join(outside, 'child'))).toBe(false);
  });

  test('symlink target inside the root pointing outside returns 403 outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = mkdtempSync(join(tmpdir(), 'vibeterm-mkdir-tgt-'));
    sandboxes.push(outside);
    symlinkSync(outside, join(dir, 'escape'));

    const { status, json } = await call({ rootId, path: join(dir, 'escape') });

    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
  });

  test('relative, NUL, and non-absolute paths return 400 invalid', async () => {
    const { dir, rootId } = sandboxRoot();
    for (const path of ['relative/foo', './foo', `${dir}/nul\0seg`, '']) {
      const { status, json } = await call({ rootId, path });
      expect(status).toBe(400);
      if (path === '') {
        expect(json).toEqual({ error: t('apiError.invalidRequest') });
      } else {
        expect(json).toEqual({ error: 'invalid', code: 'invalid' });
      }
    }
  });

  test('recursive path deeper than 64 segments is invalid', async () => {
    const { dir, rootId } = sandboxRoot();
    const segs = Array.from({ length: 65 }, (_, i) => `s${i}`);
    const path = join(dir, ...segs);
    const { status, json } = await call({ rootId, path, recursive: true });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid', code: 'invalid' });
    expect(existsSync(join(dir, 's0'))).toBe(false);
  });

  test('path longer than 4096 bytes is invalid', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = `${dir}/${'x'.repeat(4096)}`;
    const { status, json } = await call({ rootId, path, recursive: true });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'invalid', code: 'invalid' });
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

describe('POST /api/files/mkdir ssh', () => {
  test('creates via ensureRemoteDir', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const abs = `${rootPath}/new`;
    track(spyOn(deviceStorage, 'statFile').mockResolvedValue({ ok: false, code: 'not_found' }));
    const ensure = track(
      spyOn(destRemote, 'ensureRemoteDir').mockResolvedValue({
        ok: true,
        data: { dir: abs },
      })
    );

    const { status, json } = await call({ rootId, path: abs });

    expect(status).toBe(200);
    expect(json).toEqual({ path: abs, created: true });
    expect(ensure).toHaveBeenCalled();
    expect(ensure.mock.calls[0]?.[1]).toBe('new');
  });

  test('existing remote directory is idempotent created false', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const abs = `${rootPath}/already`;
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: fakeStat(abs, 'dir'),
      })
    );
    const ensure = track(
      spyOn(destRemote, 'ensureRemoteDir').mockResolvedValue({
        ok: true,
        data: { dir: abs },
      })
    );

    const { status, json } = await call({ rootId, path: abs });
    expect(status).toBe(200);
    expect(json).toEqual({ path: abs, created: false });
    expect(ensure).not.toHaveBeenCalled();
  });

  test('symlink target returns 403 outside_roots', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const abs = `${rootPath}/escape`;
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: fakeStat(abs, 'symlink', true),
      })
    );
    const ensure = track(spyOn(destRemote, 'ensureRemoteDir'));

    const { status, json } = await call({ rootId, path: abs });
    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
    expect(ensure).not.toHaveBeenCalled();
  });

  test('symlink parent returns 403 outside_roots', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const parent = `${rootPath}/link`;
    const abs = `${parent}/child`;
    track(
      spyOn(deviceStorage, 'statFile').mockImplementation(async (_id, p) => {
        if (p === abs) return { ok: false, code: 'not_found' };
        if (p === parent) return { ok: true, data: fakeStat(parent, 'symlink', true) };
        return { ok: false, code: 'not_found' };
      })
    );
    const ensure = track(spyOn(destRemote, 'ensureRemoteDir'));

    const { status, json } = await call({ rootId, path: abs });
    expect(status).toBe(403);
    expect(json).toEqual({ error: 'outside_roots', code: 'outside_roots' });
    expect(ensure).not.toHaveBeenCalled();
  });

  test('file in the way returns 400 not_a_directory', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const abs = `${rootPath}/a-file`;
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: fakeStat(abs, 'file'),
      })
    );

    const { status, json } = await call({ rootId, path: abs });
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'not_a_directory', code: 'not_a_directory' });
  });

  test('recursive true passes joined relative path to ensureRemoteDir', async () => {
    const { rootId, path: rootPath } = sshRoot();
    const abs = `${rootPath}/a/b/c`;
    track(spyOn(deviceStorage, 'statFile').mockResolvedValue({ ok: false, code: 'not_found' }));
    const ensure = track(
      spyOn(destRemote, 'ensureRemoteDir').mockResolvedValue({
        ok: true,
        data: { dir: abs },
      })
    );

    const { status, json } = await call({ rootId, path: abs, recursive: true });
    expect(status).toBe(200);
    expect(json).toEqual({ path: abs, created: true });
    expect(ensure.mock.calls[0]?.[1]).toBe('a/b/c');
  });
});
