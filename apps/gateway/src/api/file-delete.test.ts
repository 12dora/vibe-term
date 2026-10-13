import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Device, FILE_OP_MAX_PATHS } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { buildDeleteCommand, fileDeleteIo, parseDeleteOutput } from '../files/delete-remote';
import type { SshExecResult } from '../files/directory-browse';
import * as sshCommand from '../files/ssh-command';
import { t } from '../i18n';
import { fileDeleteRoutes } from './file-delete';
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

function registerRoot(path: string, type: Device['type']): string {
  const deviceId = `delete-${type}-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(deviceId, type));
  const root = createFileRoot({ deviceId, path });
  createdRootIds.push(root.id);
  return root.id;
}

function sandbox(prefix = 'vibeterm-delete-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

function sandboxRoot(): { dir: string; rootId: string } {
  const dir = sandbox();
  return { dir, rootId: registerRoot(dir, 'local') };
}

function sshRoot(path = '/remote/root'): { rootId: string; path: string } {
  return { rootId: registerRoot(path, 'ssh'), path };
}

function stubSshSpec(): void {
  track(
    spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
      targetPrefix: 'u@h:',
      rsh: 'ssh -p 22',
      env: {},
      cleanup: () => {},
    })
  );
}

function stubExec(result: Partial<SshExecResult>) {
  return track(
    spyOn(fileDeleteIo, 'execSsh').mockResolvedValue({
      stdout: new TextEncoder().encode(''),
      stderr: '',
      exitCode: 0,
      ...result,
    })
  );
}

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request('http://localhost/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, fileDeleteRoutes, { path: pathname });
  if (!response) throw new Error('no route matched POST /api/files/delete');
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

function gone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

describe('POST /api/files/delete local', () => {
  test('deletes a file', async () => {
    const { dir, rootId } = sandboxRoot();
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'x');

    const { status, json } = await call({ rootId, paths: [path] });

    expect(status).toBe(200);
    expect(json).toEqual({ results: [{ path, ok: true }] });
    expect(existsSync(path)).toBe(false);
  });

  test('deletes a non-empty directory recursively', async () => {
    const { dir, rootId } = sandboxRoot();
    const sub = join(dir, 'tree');
    mkdirSync(join(sub, 'deep/er'), { recursive: true });
    writeFileSync(join(sub, 'deep/er/f.txt'), 'x');
    writeFileSync(join(sub, 'top.txt'), 'x');

    const { status, json } = await call({ rootId, paths: [sub] });

    expect(status).toBe(200);
    expect(json).toEqual({ results: [{ path: sub, ok: true }] });
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  test('symlink is unlinked and its target survives', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = sandbox('vibeterm-delete-out-');
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(dir, 'dirlink'));
    symlinkSync(join(outside, 'keep.txt'), join(dir, 'filelink'));

    const { json } = await call({ rootId, paths: [join(dir, 'dirlink'), join(dir, 'filelink')] });

    expect(json).toEqual({
      results: [
        { path: join(dir, 'dirlink'), ok: true },
        { path: join(dir, 'filelink'), ok: true },
      ],
    });
    expect(gone(join(dir, 'dirlink'))).toBe(true);
    expect(gone(join(dir, 'filelink'))).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  test('symlinked parent escaping the root is outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = sandbox('vibeterm-delete-out-');
    writeFileSync(join(outside, 'victim.txt'), 'x');
    symlinkSync(outside, join(dir, 'link'));
    const path = join(dir, 'link', 'victim.txt');

    const { status, json } = await call({ rootId, paths: [path] });

    expect(status).toBe(200);
    expect(json).toEqual({ results: [{ path, ok: false, code: 'outside_roots' }] });
    expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
  });

  test('root itself is invalid, outside the root is outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const outside = join(dir, '..', 'escape-delete');

    const { json } = await call({ rootId, paths: [dir, `${dir}/`, outside] });

    expect(json).toEqual({
      results: [
        { path: dir, ok: false, code: 'invalid' },
        { path: dir, ok: false, code: 'invalid' },
        { path: join(dir, '..', 'escape-delete'), ok: false, code: 'outside_roots' },
      ],
    });
    expect(existsSync(dir)).toBe(true);
  });

  test('missing entries and missing parents are not_found', async () => {
    const { dir, rootId } = sandboxRoot();
    const missing = join(dir, 'nope');
    const deep = join(dir, 'nodir', 'child');

    const { json } = await call({ rootId, paths: [missing, deep] });

    expect(json).toEqual({
      results: [
        { path: missing, ok: false, code: 'not_found' },
        { path: deep, ok: false, code: 'not_found' },
      ],
    });
  });

  test('mixed batch keeps order and continues after a failure', async () => {
    const { dir, rootId } = sandboxRoot();
    writeFileSync(join(dir, 'a'), 'x');
    mkdirSync(join(dir, 'sub/inner'), { recursive: true });
    writeFileSync(join(dir, 'c'), 'x');
    const paths = [join(dir, 'a'), join(dir, 'missing'), dir, join(dir, 'sub'), `${dir}/x/../c`];

    const { status, json } = await call({ rootId, paths });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path: join(dir, 'a'), ok: true },
        { path: join(dir, 'missing'), ok: false, code: 'not_found' },
        { path: dir, ok: false, code: 'invalid' },
        { path: join(dir, 'sub'), ok: true },
        { path: join(dir, 'c'), ok: true },
      ],
    });
    expect(gone(join(dir, 'a'))).toBe(true);
    expect(gone(join(dir, 'sub'))).toBe(true);
    expect(gone(join(dir, 'c'))).toBe(true);
  });
});

describe('POST /api/files/delete validation', () => {
  test('rejects malformed bodies with 400', async () => {
    const { dir, rootId } = sandboxRoot();
    const tooMany = Array.from({ length: FILE_OP_MAX_PATHS + 1 }, (_, i) => `${dir}/f${i}`);
    const bodies: unknown[] = [
      null,
      [],
      { paths: [`${dir}/a`] },
      { rootId, paths: [] },
      { rootId, paths: 'nope' },
      { rootId, paths: tooMany },
      { rootId, paths: ['relative/a'] },
      { rootId, paths: [`${dir}/nul\0seg`] },
      { rootId, paths: [`${dir}/a`, 3] },
    ];
    for (const body of bodies) {
      const { status, json } = await call(body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: t('apiError.invalidRequest') });
    }
  });

  test('accepts exactly FILE_OP_MAX_PATHS paths', async () => {
    const { dir, rootId } = sandboxRoot();
    const paths = Array.from({ length: FILE_OP_MAX_PATHS }, (_, i) => `${dir}/f${i}`);
    const { status, json } = await call({ rootId, paths });
    expect(status).toBe(200);
    expect((json.results as unknown[]).length).toBe(FILE_OP_MAX_PATHS);
  });

  test('unknown root returns 404 root_not_found', async () => {
    const { status, json } = await call({ rootId: 'no-such-root', paths: ['/tmp/x'] });
    expect(status).toBe(404);
    expect(json).toEqual({ error: 'root_not_found', code: 'root_not_found' });
  });
});

describe('remote delete script', () => {
  test('builder quotes every path and always passes --', () => {
    const script = buildDeleteCommand("/remote/ro'ot", [
      { index: 0, path: "/remote/ro'ot/-rf" },
      { index: 3, path: '/remote/ro\'ot/sub dir/$(x) "q"' },
    ]);

    expect(script).toContain(`cd -- '/remote/ro'\\''ot' 2>/dev/null && pwd -P`);
    expect(script).toContain(`rm -rf -- './-rf'`);
    expect(script).toContain(`cd -- '/remote/ro'\\''ot/sub dir' 2>/dev/null`);
    expect(script).toContain(`rm -rf -- './\$(x) "q"'`);
    expect(script).toContain('echo "VTOP 0 ok"');
    expect(script).toContain('echo "VTOP 3 permission_denied"');
    expect(script).toContain('echo "VTOP 3 outside_roots"');
  });

  test('parser maps status lines and degrades unknown ones', () => {
    const out = parseDeleteOutput(
      new TextEncoder().encode(
        'banner\nVTOP 0 ok\nVTOP 1 not_found\r\nVTOP 2 outside_roots\nVTOP 4 permission_denied\nVTOP 5 weird\nVTOP x ok\n'
      )
    );
    expect([...out.entries()]).toEqual([
      [0, 'ok'],
      [1, 'not_found'],
      [2, 'outside_roots'],
      [4, 'permission_denied'],
      [5, 'unknown'],
    ]);
  });
});

describe('POST /api/files/delete ssh', () => {
  test('sends one batched script and maps status lines, missing line is unknown', async () => {
    const { rootId, path } = sshRoot();
    stubSshSpec();
    const exec = stubExec({
      stdout: new TextEncoder().encode('VTOP 0 ok\nVTOP 3 not_found\n'),
    });
    const paths = [`${path}/a`, `${path}/-weird name`, path, `${path}/gone`, `${path}/../out`];

    const { status, json } = await call({ rootId, paths });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path: `${path}/a`, ok: true },
        { path: `${path}/-weird name`, ok: false, code: 'unknown' },
        { path, ok: false, code: 'invalid' },
        { path: `${path}/gone`, ok: false, code: 'not_found' },
        { path: '/remote/out', ok: false, code: 'outside_roots' },
      ],
    });
    expect(exec).toHaveBeenCalledTimes(1);
    const command = exec.mock.calls[0]?.[1] as string;
    expect(command).toContain(`rm -rf -- './-weird name'`);
    expect(command).toContain(`rm -rf -- './gone'`);
    expect(command).not.toContain('VTOP 2 ');
    expect(command).not.toContain('VTOP 4 ');
    expect(exec.mock.calls[0]?.[2]).toBe(60_000);
  });

  test('does not contact the device when every item is rejected lexically', async () => {
    const { rootId, path } = sshRoot();
    stubSshSpec();
    const exec = stubExec({});

    const { status, json } = await call({ rootId, paths: [path, '/etc/passwd'] });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path, ok: false, code: 'invalid' },
        { path: '/etc/passwd', ok: false, code: 'outside_roots' },
      ],
    });
    expect(exec).not.toHaveBeenCalled();
  });

  test('ssh exit codes become request-level errors', async () => {
    const { rootId, path } = sshRoot();
    stubSshSpec();
    const cases: Array<[number, number, string]> = [
      [255, 502, 'connection_failed'],
      [124, 504, 'timeout'],
      [60, 404, 'root_not_found'],
      [1, 500, 'unknown'],
    ];
    for (const [exitCode, httpStatus, code] of cases) {
      stubExec({ exitCode, stderr: 'boom' });
      const { status, json } = await call({ rootId, paths: [`${path}/a`] });
      expect(status).toBe(httpStatus);
      expect(json).toMatchObject({ error: code, code });
      spies.pop()?.mockRestore();
    }
  });

  test('script executed by a real shell deletes safely', async () => {
    const dir = sandbox('vibeterm-delete-sh-');
    const outside = sandbox('vibeterm-delete-sh-out-');
    const rootId = registerRoot(dir, 'ssh');
    writeFileSync(join(dir, '-rf'), 'x');
    writeFileSync(join(dir, "it's here"), 'x');
    mkdirSync(join(dir, 'tree/inner'), { recursive: true });
    writeFileSync(join(dir, 'tree/inner/f'), 'x');
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(dir, 'escape'));
    symlinkSync(join(outside, 'keep.txt'), join(dir, 'ln'));
    stubSshSpec();
    track(
      spyOn(fileDeleteIo, 'execSsh').mockImplementation(async (_spec, command) => {
        const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout: new Uint8Array(stdout), stderr, exitCode };
      })
    );
    const paths = [
      join(dir, '-rf'),
      join(dir, "it's here"),
      join(dir, 'tree'),
      join(dir, 'ln'),
      join(dir, 'escape', 'keep.txt'),
      join(dir, 'missing'),
      join(dir, 'nodir', 'x'),
    ];

    const { status, json } = await call({ rootId, paths });

    expect(status).toBe(200);
    const codes = (json.results as Array<{ ok: boolean; code?: string }>).map((r) =>
      r.ok ? 'ok' : r.code
    );
    expect(codes).toEqual(['ok', 'ok', 'ok', 'ok', 'outside_roots', 'not_found', 'not_found']);
    expect(gone(join(dir, '-rf'))).toBe(true);
    expect(gone(join(dir, "it's here"))).toBe(true);
    expect(gone(join(dir, 'tree'))).toBe(true);
    expect(gone(join(dir, 'ln'))).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(lstatSync(join(dir, 'escape')).isSymbolicLink()).toBe(true);
  });
});
