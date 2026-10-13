import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type Device, FILE_OP_MAX_PATHS, type FileStatResponse } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { type ArchiveProcess, fileArchiveIo } from '../files/archive-stream';
import * as deviceStorage from '../files/device-storage';
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

describe('ssh devices', () => {
  function stubSsh(content: string) {
    const cleanup = mock(() => {});
    track(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
        targetPrefix: 'user@host:',
        rsh: 'ssh -o BatchMode=yes',
        env: { SSH_AUTH_SOCK: '/sock' },
        cleanup,
      })
    );
    const kill = mock(() => {});
    const proc: ArchiveProcess = {
      stdout: new Response(content).body as ReadableStream<Uint8Array>,
      stderr: null,
      exited: Promise.resolve(0),
      kill,
    };
    const spawn = track(spyOn(fileArchiveIo, 'spawn').mockImplementation(() => proc));
    return { cleanup, spawn };
  }

  test('prepare stats the parent once; download spawns ssh and cleans the spec when done', async () => {
    const { rootId, path } = sshRoot();
    const stat = track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: fakeStat(path, 'dir'),
      })
    );
    const { cleanup, spawn } = stubSsh('TARDATA');

    const ticket = await prepared(rootId, [`${path}/x`, `${path}/y z`]);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls[0]).toEqual([rootId, path]);
    expect(ticket.name).toBe('root.tar.gz');

    const res = await download(ticket.archiveId);
    expect(res.status).toBe(200);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await res.text()).toBe('TARDATA');

    const [argv, env] = spawn.mock.calls[0] as [string[], Record<string, string>];
    expect(argv.slice(0, 3)).toEqual(['ssh', '-o', 'BatchMode=yes']);
    expect(argv[3]).toBe('user@host');
    expect(argv[4]).toBe(`'tar' '-czf' '-' '-C' '${path}' './x' './y z'`);
    expect(env.SSH_AUTH_SOCK).toBe('/sock');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('archiving the root itself stats the root and names the archive after it', async () => {
    const { rootId, path } = sshRoot();
    const stat = track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: fakeStat(path, 'dir'),
      })
    );

    const ticket = await prepared(rootId, [path]);

    expect(stat.mock.calls[0]).toEqual([rootId, path]);
    expect(ticket.name).toBe('root.tar.gz');
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
    track(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({ ok: true, data: fakeStat(path, 'dir') })
    );
    const ticket = await prepared(rootId, [`${path}/x`]);
    track(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockRejectedValue(
        new sshCommand.RsyncAuthError('auth_unsupported', 'no key')
      )
    );
    const spawn = track(spyOn(fileArchiveIo, 'spawn'));

    const res = await download(ticket.archiveId);

    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });
});
