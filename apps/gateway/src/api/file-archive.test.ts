import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type Device, FILE_OP_MAX_PATHS, type FileStatResponse } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot, updateFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { fileArchiveIo } from '../files/archive-stream';
import * as deviceStorage from '../files/device-storage';
import { type RemoteScriptProcess, remoteScriptIo } from '../files/remote-script';
import * as sshCommand from '../files/ssh-command';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import {
  archiveTicketClock,
  fileArchiveRoutes,
  prepareArchive,
  resetArchiveTickets,
} from './file-archive';
import { dispatchRoutes } from './route';

beforeAll(() => {
  runMigrations();
});

const originalRemoteSpawn = remoteScriptIo.spawn;
const createdRootIds: string[] = [];
const sandboxes: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

afterEach(() => {
  remoteScriptIo.spawn = originalRemoteSpawn;
  while (spies.length > 0) spies.pop()?.mockRestore();
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
  resetArchiveTickets();
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

function tmpSandbox(prefix = 'vibeterm-archive-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

function sandboxRoot(): { dir: string; rootId: string } {
  const dir = tmpSandbox();
  const deviceId = `archive-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(deviceId));
  const root = createFileRoot({ deviceId, path: dir });
  createdRootIds.push(root.id);
  return { dir, rootId: root.id };
}

function sshRoot(path = '/remote/root'): { rootId: string; path: string } {
  const deviceId = `archive-ssh-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(deviceId, 'ssh'));
  const root = createFileRoot({ deviceId, path });
  createdRootIds.push(root.id);
  return { rootId: root.id, path };
}

function call(
  method: string,
  path: string,
  opts: { uid?: string; body?: unknown; rawBody?: string } = {}
): Promise<Response> {
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body,
  });
  if (opts.uid !== undefined) {
    requestDispatchContext.set(req, { uid: opts.uid, viaNodeId: 'self' });
  }
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, fileArchiveRoutes, { path: pathname });
  if (!response) throw new Error(`no route matched ${method} ${path}`);
  return Promise.resolve(response);
}

async function prepare(
  rootId: string,
  paths: string[],
  uid?: string
): Promise<{ status: number; json: Record<string, string> }> {
  const res = await call('POST', '/api/files/archive/prepare', { uid, body: { rootId, paths } });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

async function prepared(rootId: string, paths: string[], uid?: string) {
  const { status, json } = await prepare(rootId, paths, uid);
  expect(status).toBe(200);
  return json as { archiveId: string; name: string };
}

function download(id: string, uid?: string): Promise<Response> {
  return call('GET', `/api/files/archive/${encodeURIComponent(id)}`, { uid });
}

function fakeStat(path: string, type: FileStatResponse['type']): FileStatResponse {
  return {
    path,
    name: basename(path),
    type,
    category: type === 'dir' ? 'directory' : 'other',
    size: 0,
    modifiedAt: null,
    mime: null,
    isSymlink: type === 'symlink',
  };
}

function fillSandbox(dir: string): void {
  writeFileSync(join(dir, 'a b.txt'), 'with spaces');
  writeFileSync(join(dir, '-dash'), 'leading dash');
  mkdirSync(join(dir, 'sub/nested'), { recursive: true });
  writeFileSync(join(dir, 'sub/nested/deep.txt'), 'deep');
  writeFileSync(join(dir, 'sub/top.txt'), 'top');
}

describe('POST /api/files/archive/prepare validation', () => {
  test('rejects malformed bodies with 400 invalidRequest', async () => {
    const { dir, rootId } = sandboxRoot();
    const good = join(dir, 'x');
    const tooMany = Array.from({ length: FILE_OP_MAX_PATHS + 1 }, (_, i) => `${dir}/f${i}`);
    const bodies: unknown[] = [
      { rootId, paths: [] },
      { rootId, paths: tooMany },
      { rootId, paths: ['relative/path'] },
      { rootId, paths: [`${good}\0`] },
      { rootId, paths: [good, 5] },
      { rootId: '', paths: [good] },
      { paths: [good] },
      { rootId, paths: good },
    ];
    for (const body of bodies) {
      const res = await call('POST', '/api/files/archive/prepare', { body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: t('apiError.invalidRequest') });
    }
    const notJson = await call('POST', '/api/files/archive/prepare', { rawBody: '{nope' });
    expect(notJson.status).toBe(400);
  });

  test('paths with different parents are invalid', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);

    const { status, json } = await prepare(rootId, [
      join(dir, 'a b.txt'),
      join(dir, 'sub/top.txt'),
    ]);

    expect(status).toBe(400);
    expect(json.code).toBe('invalid');
  });

  test('unknown root is 404 root_not_found', async () => {
    const { status, json } = await prepare('no-such-root', ['/tmp/x']);
    expect(status).toBe(404);
    expect(json.code).toBe('root_not_found');
  });

  test('path outside the root is 403 outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    const { status, json } = await prepare(rootId, [join(dir, '..', 'escape')]);
    expect(status).toBe(403);
    expect(json.code).toBe('outside_roots');
  });

  test('missing local path is 404 not_found', async () => {
    const { dir, rootId } = sandboxRoot();
    const { status, json } = await prepare(rootId, [join(dir, 'ghost')]);
    expect(status).toBe(404);
    expect(json.code).toBe('not_found');
  });

  test('prepareArchive itself rejects an empty path list', async () => {
    const { rootId } = sandboxRoot();
    const result = await prepareArchive({ rootId, paths: [] }, null);
    expect(result).toEqual({ ok: false, code: 'invalid', detail: undefined });
  });
});

describe('suggested names', () => {
  test('single file, single directory, several items, the root itself', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);

    expect((await prepared(rootId, [join(dir, 'a b.txt')])).name).toBe('a b.txt.tar.gz');
    expect((await prepared(rootId, [join(dir, 'sub')])).name).toBe('sub.tar.gz');
    expect((await prepared(rootId, [join(dir, 'sub'), join(dir, '-dash')])).name).toBe(
      `${basename(dir)}.tar.gz`
    );
    expect((await prepared(rootId, [dir])).name).toBe(`${basename(dir)}.tar.gz`);
  });

  test('duplicate paths collapse to a single item', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const file = join(dir, 'a b.txt');

    expect((await prepared(rootId, [file, `${dir}/./a b.txt`])).name).toBe('a b.txt.tar.gz');
  });

  test('archive ids are long URL-safe tokens and unique', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const a = await prepared(rootId, [join(dir, 'sub')]);
    const b = await prepared(rootId, [join(dir, 'sub')]);

    expect(a.archiveId).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a.archiveId).not.toBe(b.archiveId);
  });
});

describe('ticket ownership and expiry', () => {
  test('another uid gets 404, the owner can download, standalone matches standalone', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const mine = await prepared(rootId, [join(dir, 'a b.txt')], 'alice');
    const standalone = await prepared(rootId, [join(dir, 'a b.txt')]);

    const other = await download(mine.archiveId, 'bob');
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not_found', code: 'not_found' });
    expect((await download(mine.archiveId)).status).toBe(404);
    expect((await download(mine.archiveId, 'alice')).status).toBe(200);
    expect((await download(standalone.archiveId)).status).toBe(200);
    expect((await download(standalone.archiveId, 'alice')).status).toBe(404);
  });

  test('unknown ids are 404', async () => {
    expect((await download('nope')).status).toBe(404);
  });

  test('tickets expire after five minutes and can be retried before that', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    let now = 1_000_000;
    track(spyOn(archiveTicketClock, 'now').mockImplementation(() => now));
    const ticket = await prepared(rootId, [join(dir, 'a b.txt')]);

    now += 5 * 60_000 - 1;
    expect((await download(ticket.archiveId)).status).toBe(200);
    expect((await download(ticket.archiveId)).status).toBe(200);
    now += 1;
    expect((await download(ticket.archiveId)).status).toBe(404);
  });

  test('at most 256 live tickets; expired ones are swept to make room', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    let now = 1_000_000;
    track(spyOn(archiveTicketClock, 'now').mockImplementation(() => now));
    const path = join(dir, 'a b.txt');

    for (let i = 0; i < 256; i++) expect((await prepare(rootId, [path])).status).toBe(200);
    const full = await prepare(rootId, [path]);
    expect(full.status).toBe(400);
    expect(full.json.code).toBe('invalid');
    expect(full.json.detail).toBe('too_many_archives');

    now += 5 * 60_000;
    expect((await prepare(rootId, [path])).status).toBe(200);
  });
});

describe('GET /api/files/archive/:id (local tar)', () => {
  test('streams a tar.gz that extracts to the original tree', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const ticket = await prepared(rootId, [
      join(dir, 'a b.txt'),
      join(dir, '-dash'),
      join(dir, 'sub'),
    ]);

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/gzip');
    expect(res.headers.get('Content-Length')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent(ticket.name)}`
    );
    const work = tmpSandbox('vibeterm-archive-out-');
    const archivePath = join(work, 'out.tar.gz');
    writeFileSync(archivePath, new Uint8Array(await res.arrayBuffer()));
    const extractDir = join(work, 'x');
    mkdirSync(extractDir);
    const untar = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', extractDir]);
    expect(untar.exitCode).toBe(0);
    expect(readFileSync(join(extractDir, 'a b.txt'), 'utf8')).toBe('with spaces');
    expect(readFileSync(join(extractDir, '-dash'), 'utf8')).toBe('leading dash');
    expect(readFileSync(join(extractDir, 'sub/nested/deep.txt'), 'utf8')).toBe('deep');
    expect(readFileSync(join(extractDir, 'sub/top.txt'), 'utf8')).toBe('top');
  });

  test('a file removed after prepare is 404 not_found instead of a broken stream', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const ticket = await prepared(rootId, [join(dir, 'a b.txt')]);
    unlinkSync(join(dir, 'a b.txt'));

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  test('an item swapped for a link leaving the root is 403 outside_roots', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const outside = tmpSandbox('vibeterm-archive-secret-');
    writeFileSync(join(outside, 'secret'), 'secret');
    const ticket = await prepared(rootId, [join(dir, 'a b.txt')]);
    unlinkSync(join(dir, 'a b.txt'));
    symlinkSync(join(outside, 'secret'), join(dir, 'a b.txt'));

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/files/archive/:id re-validates against the current root (local)', () => {
  test('a root moved after prepare is 403 outside_roots and spawns nothing', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const moved = tmpSandbox('vibeterm-archive-moved-');
    const spawn = track(spyOn(fileArchiveIo, 'spawn'));
    const ticket = await prepared(rootId, [join(dir, 'sub/top.txt')]);
    const rootTicket = await prepared(rootId, [dir]);
    updateFileRoot(rootId, { path: moved });

    for (const id of [ticket.archiveId, rootTicket.archiveId]) {
      const res = await download(id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('outside_roots');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  test('the root itself still downloads', async () => {
    const { dir, rootId } = sandboxRoot();
    fillSandbox(dir);
    const ticket = await prepared(rootId, [dir]);

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(200);
    const extractDir = extract(new Uint8Array(await res.arrayBuffer()));
    expect(readFileSync(join(extractDir, basename(dir), 'a b.txt'), 'utf8')).toBe('with spaces');
  });
});

function realSandbox(prefix = 'vibeterm-archive-'): string {
  return realpathSync(tmpSandbox(prefix));
}

async function drain(res: Response): Promise<{ bytes: Uint8Array; error: unknown }> {
  const chunks: Uint8Array[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (error) {
    return { bytes: Buffer.concat(chunks), error };
  }
  return { bytes: Buffer.concat(chunks), error: null };
}

function extract(bytes: Uint8Array): string {
  const work = tmpSandbox('vibeterm-archive-out-');
  const archivePath = join(work, 'out.tar.gz');
  writeFileSync(archivePath, bytes);
  const extractDir = join(work, 'x');
  mkdirSync(extractDir);
  const untar = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', extractDir]);
  expect(untar.exitCode).toBe(0);
  return extractDir;
}

describe('ssh devices', () => {
  interface RemoteCall {
    argv: string[];
    script: string;
  }

  function stubSpec(overrides: Partial<sshCommand.RsyncDeviceSpec> = {}) {
    const cleanup = mock(() => {});
    track(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
        targetPrefix: 'user@host:',
        rsh: 'ssh -o BatchMode=yes',
        env: { SSH_AUTH_SOCK: '/sock' },
        cleanup,
        ...overrides,
      })
    );
    return cleanup;
  }

  function stubStat() {
    return track(
      spyOn(deviceStorage, 'statFile').mockImplementation(async (_root, path) => ({
        ok: true,
        data: fakeStat(path, 'dir'),
      }))
    );
  }

  /** 「远端」换成本机 sh：脚本原样交给 `sh -s`，路径落在临时沙箱里。 */
  function runLocally(): RemoteCall[] {
    const calls: RemoteCall[] = [];
    remoteScriptIo.spawn = (argv, env, script) => {
      calls.push({ argv, script });
      return originalRemoteSpawn(['sh', '-s'], env, script);
    };
    return calls;
  }

  function fakeProcess(stdout: ReadableStream<Uint8Array>) {
    const kill = mock(() => {});
    const proc: RemoteScriptProcess = {
      stdout,
      stderr: new Response('').body as ReadableStream<Uint8Array>,
      exited: Promise.resolve(0),
      kill,
    };
    return { proc, kill };
  }

  test('prepare stats the parent once; download round-trips through sh -s and cleans up once', async () => {
    const dir = realSandbox();
    fillSandbox(dir);
    const { rootId } = sshRoot(dir);
    const stat = stubStat();
    const cleanup = stubSpec();
    const calls = runLocally();

    const ticket = await prepared(rootId, [
      join(dir, 'a b.txt'),
      join(dir, '-dash'),
      join(dir, 'sub'),
    ]);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls[0]).toEqual([rootId, dir]);
    expect(ticket.name).toBe(`${basename(dir)}.tar.gz`);

    const res = await download(ticket.archiveId);
    expect(res.status).toBe(200);
    expect(cleanup).not.toHaveBeenCalled();
    const { bytes, error } = await drain(res);

    expect(error).toBeNull();
    expect(calls[0]?.argv).toEqual(['ssh', '-o', 'BatchMode=yes', 'user@host', 'sh -s']);
    const extractDir = extract(bytes);
    expect(readFileSync(join(extractDir, 'a b.txt'), 'utf8')).toBe('with spaces');
    expect(readFileSync(join(extractDir, '-dash'), 'utf8')).toBe('leading dash');
    expect(readFileSync(join(extractDir, 'sub/nested/deep.txt'), 'utf8')).toBe('deep');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('a symlinked parent leaving the root errors the stream, leaks nothing and still cleans up', async () => {
    const dir = realSandbox();
    const outside = realSandbox('vibeterm-archive-secret-');
    writeFileSync(join(outside, 'secret'), 'TOP-SECRET');
    symlinkSync(outside, join(dir, 'link'));
    const { rootId } = sshRoot(dir);
    stubStat();
    const cleanup = stubSpec();
    runLocally();
    const warn = track(spyOn(console, 'warn').mockImplementation(() => {}));

    const ticket = await prepared(rootId, [join(dir, 'link/secret')]);
    const res = await download(ticket.archiveId);
    const { bytes, error } = await drain(res);

    expect(String(error)).toContain('archive_exit_64');
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('TOP-SECRET');
    expect(bytes.byteLength).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain('archive_parent_outside_root');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('a root and parent directory with a trailing newline are archived correctly', async () => {
    const base = realSandbox();
    const root = join(base, 'root\n');
    mkdirSync(join(root, 'd\n'), { recursive: true });
    writeFileSync(join(root, 'd\n', 'f1'), 'inner');
    const { rootId } = sshRoot(root);
    stubStat();
    stubSpec();
    runLocally();

    const ticket = await prepared(rootId, [join(root, 'd\n', 'f1')]);
    const { bytes, error } = await drain(await download(ticket.archiveId));

    expect(error).toBeNull();
    expect(readFileSync(join(extract(bytes), 'f1'), 'utf8')).toBe('inner');
  });

  test('a newline-named root is not confused with its newline-less sibling', async () => {
    const base = realSandbox();
    const root = join(base, 'root\n');
    mkdirSync(root);
    mkdirSync(join(base, 'root'));
    writeFileSync(join(base, 'root', 'secret'), 'SIBLING-SECRET');
    symlinkSync(join(base, 'root'), join(root, 'link'));
    const { rootId } = sshRoot(root);
    stubStat();
    stubSpec();
    runLocally();
    track(spyOn(console, 'warn').mockImplementation(() => {}));

    const ticket = await prepared(rootId, [join(root, 'link', 'secret')]);
    const { bytes, error } = await drain(await download(ticket.archiveId));

    expect(String(error)).toContain('archive_exit_64');
    expect(bytes.byteLength).toBe(0);
  });

  test('500 names of 255 bytes go through stdin, argv stays `sh -s`', async () => {
    const dir = realSandbox();
    const names = Array.from(
      { length: FILE_OP_MAX_PATHS },
      (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(252)}`
    );
    for (const name of names) writeFileSync(join(dir, name), '');
    const { rootId } = sshRoot(dir);
    stubStat();
    stubSpec();
    const calls = runLocally();

    const ticket = await prepared(
      rootId,
      names.map((name) => join(dir, name))
    );
    const { bytes, error } = await drain(await download(ticket.archiveId));

    expect(error).toBeNull();
    expect(calls[0]?.argv.at(-1)).toBe('sh -s');
    expect(calls[0]?.argv.join(' ').length).toBeLessThan(200);
    expect(calls[0]?.script.length).toBeGreaterThan(FILE_OP_MAX_PATHS * 255);
    const extractDir = extract(bytes);
    expect(readFileSync(join(extractDir, names[499] as string), 'utf8')).toBe('');
  });

  test('client cancel kills the remote process and cleans up once', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    const cleanup = stubSpec();
    const fake = fakeProcess(new ReadableStream<Uint8Array>({}));
    remoteScriptIo.spawn = () => fake.proc;

    const ticket = await prepared(rootId, [`${path}/x`]);
    const res = await download(ticket.archiveId);
    expect(res.status).toBe(200);
    await res.body?.cancel();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('spawn throwing cleans up and answers 500', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    const cleanup = stubSpec();
    const ticket = await prepared(rootId, [`${path}/x`]);
    remoteScriptIo.spawn = () => {
      throw new Error('ENOENT ssh');
    };

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(500);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('a non-ssh spec spawns nothing, cleans up and answers 500', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    const cleanup = stubSpec({ rsh: undefined });
    const ticket = await prepared(rootId, [`${path}/x`]);
    const spawn = mock(() => {
      throw new Error('should not spawn');
    });
    remoteScriptIo.spawn = spawn;

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(500);
    expect(spawn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('the script verifies physical paths, quotes every value and execs tar without -C', async () => {
    const { rootId, path } = sshRoot("/remote/it's root");
    stubStat();
    stubSpec();
    const fake = fakeProcess(new Response('').body as ReadableStream<Uint8Array>);
    let script = '';
    remoteScriptIo.spawn = (_argv, _env, text) => {
      script = text;
      return fake.proc;
    };

    const ticket = await prepared(rootId, [`${path}/sub/x`, `${path}/sub/y z`]);
    await drain(await download(ticket.archiveId));

    expect(script).toContain("cd -- '/remote/it'\\''s root' ||");
    expect(script).toContain("cd -- '/remote/it'\\''s root/sub' ||");
    expect(script).toContain('inside "$PHYS" "$r" ||');
    expect(script).toContain("exec tar -czf - './x' './y z'\n");
    expect(script).not.toContain('-C');
  });

  test('the root itself (parent outside the root) skips the boundary check', async () => {
    const { rootId, path } = sshRoot();
    const stat = stubStat();
    stubSpec();
    const fake = fakeProcess(new Response('').body as ReadableStream<Uint8Array>);
    let script = '';
    remoteScriptIo.spawn = (_argv, _env, text) => {
      script = text;
      return fake.proc;
    };

    const ticket = await prepared(rootId, [path]);
    await drain(await download(ticket.archiveId));

    expect(stat.mock.calls[0]).toEqual([rootId, path]);
    expect(ticket.name).toBe('root.tar.gz');
    expect(script).toContain("cd -- '/remote' ||");
    expect(script).not.toContain('inside');
    expect(script).toContain("exec tar -czf - './root'\n");
  });

  test('a root re-pointed after prepare is 403 outside_roots and spawns nothing', async () => {
    const { rootId } = sshRoot('/safe');
    stubStat();
    stubSpec();
    const spawn = mock(() => {
      throw new Error('should not spawn');
    });
    remoteScriptIo.spawn = spawn;
    const nested = await prepared(rootId, ['/safe/sub/secret']);
    const rootTicket = await prepared(rootId, ['/safe']);
    updateFileRoot(rootId, { path: '/restricted' });

    for (const id of [nested.archiveId, rootTicket.archiveId]) {
      const res = await download(id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('outside_roots');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a multi-entry ticket reaching outside the narrowed root is rejected before spawning', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    stubSpec();
    const spawn = mock(() => {
      throw new Error('should not spawn');
    });
    remoteScriptIo.spawn = spawn;
    const ticket = await prepared(rootId, [`${path}/sub/a`, `${path}/sub/b`]);
    updateFileRoot(rootId, { path: `${path}/sub/a` });

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('outside_roots');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a single entry that is no longer the root gets the physical boundary check', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    stubSpec();
    const fake = fakeProcess(new Response('').body as ReadableStream<Uint8Array>);
    let script = '';
    remoteScriptIo.spawn = (_argv, _env, text) => {
      script = text;
      return fake.proc;
    };
    const ticket = await prepared(rootId, [`${path}/sub`]);
    updateFileRoot(rootId, { path: '/remote' });

    await drain(await download(ticket.archiveId));

    expect(script).toContain('inside "$PHYS" "$r" ||');
    expect(script).toContain("cd -- '/remote' ||");
  });

  test('a parent that is a file is 400 not_a_directory; stat failures propagate', async () => {
    const { rootId, path } = sshRoot();
    const stat = track(
      spyOn(deviceStorage, 'statFile').mockResolvedValueOnce({
        ok: true,
        data: fakeStat(path, 'file'),
      })
    );
    expect((await prepare(rootId, [`${path}/x`])).json.code).toBe('not_a_directory');

    stat.mockResolvedValueOnce({ ok: false, code: 'connection_failed' });
    const failed = await prepare(rootId, [`${path}/x`]);
    expect(failed.status).toBe(502);
    expect(failed.json.code).toBe('connection_failed');
  });

  test('spec auth failures surface as request errors and nothing is spawned', async () => {
    const { rootId, path } = sshRoot();
    stubStat();
    const ticket = await prepared(rootId, [`${path}/x`]);
    track(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockRejectedValue(
        new sshCommand.RsyncAuthError('auth_unsupported', 'no key')
      )
    );
    const spawn = mock(() => {
      throw new Error('should not spawn');
    });
    remoteScriptIo.spawn = spawn;

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('root path "/"', () => {
  test('prepare names the archive files.tar.gz and the tar args archive "." from "/"', async () => {
    const { rootId } = sshRoot('/');
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({ ok: true, data: fakeStat('/', 'dir') })
    );
    track(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
        targetPrefix: 'user@host:',
        rsh: 'ssh',
        env: {},
        cleanup: () => {},
      })
    );
    let script = '';
    remoteScriptIo.spawn = (_argv, _env, text) => {
      script = text;
      return {
        stdout: new Response('').body as ReadableStream<Uint8Array>,
        stderr: new Response('').body as ReadableStream<Uint8Array>,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };

    const ticket = await prepared(rootId, ['/', '/etc']);
    expect(ticket.name).toBe('files.tar.gz');
    await drain(await download(ticket.archiveId));

    expect(script).toContain("cd -- '/' ||");
    expect(script).toContain("exec tar -czf - '.'\n");
    expect(script).not.toContain('./etc');
  });

  test('a single entry below "/" keeps its own name', async () => {
    const { rootId } = sshRoot('/');
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({ ok: true, data: fakeStat('/', 'dir') })
    );
    expect((await prepared(rootId, ['/etc'])).name).toBe('etc.tar.gz');
  });
});

describe('Content-Disposition', () => {
  test('a Chinese / emoji name gives an ASCII-only filename and the full UTF-8 filename*', async () => {
    const { dir, rootId } = sandboxRoot();
    // 名称里不放反斜杠：Bun 1.4 的 realpathSync 认不出带 `\\` 的路径，prepare 阶段就会回 not_found
    const fileName = '报告 🙂 "q".txt';
    writeFileSync(join(dir, fileName), 'x');
    const ticket = await prepared(rootId, [join(dir, fileName)]);

    const res = await download(ticket.archiveId);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /^attachment; filename="([^"\\]*)"; filename\*=UTF-8''(\S+)$/.exec(disposition);

    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/^[\x20-\x7E]*$/);
    expect(match?.[1]).toContain('.txt.tar.gz');
    expect(decodeURIComponent(match?.[2] ?? '')).toBe(`${fileName}.tar.gz`);
    await res.body?.cancel();
  });
});
