import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildContext } from '../core/context';
import { CliError, NotFoundError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { command as files } from './files';

const ENTRY = 'http://entry.example:9883';
const NODE = 'a'.repeat(32);
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function collector(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

const ROOT = {
  id: ROOT_ID,
  name: 'home',
  path: '/home/me',
  deviceId: 'd-1',
  deviceName: 'laptop',
  deviceType: 'local',
  enabled: true,
  sortOrder: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function splitPath(url: string): { nodeId: string; path: string; search: URLSearchParams } {
  const parsed = new URL(url);
  const match = /^\/n\/([0-9a-f]{32})(\/.*)$/.exec(parsed.pathname);
  return match
    ? { nodeId: match[1], path: match[2], search: parsed.searchParams }
    : { nodeId: 'self', path: parsed.pathname, search: parsed.searchParams };
}

function filesFetch(
  overrides: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {}
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init as RequestInit);
    const url = new URL(request.url);
    const { path, search } = splitPath(request.url);
    const key = `${request.method} ${path}`;
    if (overrides[key]) return overrides[key](request, url);
    if (path === '/api/mesh/nodes') {
      return json({
        nodes: [{ id: NODE, name: 'office', publicKey: 'x', online: true, loggedIn: true }],
      });
    }
    if (path === '/api/devices') {
      return json({ devices: [{ id: 'd-1', name: 'laptop', type: 'local' }] });
    }
    if (path === '/api/files/roots' && request.method === 'GET') return json({ roots: [ROOT] });
    if (path === '/api/files/roots' && request.method === 'POST') {
      const body = (await request.json()) as { deviceId: string; path: string };
      return json(
        { root: { ...ROOT, id: 'new-root', path: body.path, deviceId: body.deviceId } },
        201
      );
    }
    if (path.startsWith('/api/files/roots/') && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path === '/api/files/roots/order') return json({ roots: [ROOT] });
    if (path === '/api/files/list') {
      return json({
        path: search.get('path') ?? ROOT.path,
        truncated: false,
        entries: [
          {
            name: 'docs',
            path: '/home/me/docs',
            type: 'dir',
            category: 'directory',
            size: null,
            modifiedAt: '2026-01-01T00:00:00Z',
            isSymlink: false,
          },
          {
            name: '.secret',
            path: '/home/me/.secret',
            type: 'file',
            category: 'text',
            size: 3,
            modifiedAt: null,
            isSymlink: false,
          },
          {
            name: 'a.txt',
            path: '/home/me/a.txt',
            type: 'file',
            category: 'text',
            size: 4,
            modifiedAt: '2026-01-02T00:00:00Z',
            isSymlink: false,
          },
        ],
      });
    }
    if (path === '/api/files/stat') {
      return json({
        path: search.get('path'),
        name: 'a.txt',
        type: 'file',
        category: 'text',
        size: 4,
        modifiedAt: '2026-01-02T00:00:00Z',
        mime: 'text/plain',
        isSymlink: false,
      });
    }
    if (path === '/api/files/raw') {
      return new Response(Buffer.from([0x61, 0x00, 0x62]), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return json({ error: 'not_found', code: 'not_found' }, 404);
  };
}

async function testContext(fetchImpl: FetchLike, options: { json?: boolean; node?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-files-'));
  dirs.push(dir);
  const stdout = collector();
  const stderr = collector();
  const ctx = buildContext({
    entryFlag: ENTRY,
    node: options.node ?? null,
    json: options.json ?? false,
    quiet: false,
    noColor: true,
    configDir: dir,
    installEntry: null,
    env: {},
    fetchImpl,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { ctx, stdout, stderr };
}

describe('vibeterm files', () => {
  test('roots --json lists roots', async () => {
    const { ctx, stdout } = await testContext(filesFetch(), { json: true });
    await files.run(ctx, ['roots']);
    const payload = JSON.parse(stdout.text()) as { roots: Array<{ name: string }> };
    expect(payload.roots[0].name).toBe('home');
  });

  test('ls hides dotfiles unless --all', async () => {
    const { ctx, stdout } = await testContext(filesFetch());
    await files.run(ctx, ['ls', 'home']);
    expect(stdout.text()).toContain('docs/');
    expect(stdout.text()).toContain('a.txt');
    expect(stdout.text()).not.toContain('.secret');
  });

  test('ls --all --json includes hidden and truncated flag', async () => {
    const { ctx, stdout } = await testContext(filesFetch(), { json: true });
    await files.run(ctx, ['ls', 'office:home', '--all']);
    const payload = JSON.parse(stdout.text()) as { entries: Array<{ name: string }>; node: string };
    expect(payload.node).toBe(NODE);
    expect(payload.entries.map((row) => row.name)).toContain('.secret');
  });

  test('stat and cat', async () => {
    const { ctx, stdout } = await testContext(filesFetch(), { json: true });
    await files.run(ctx, ['stat', 'home/a.txt']);
    expect(JSON.parse(stdout.text()).name).toBe('a.txt');
    const cat = await testContext(filesFetch());
    await files.run(cat.ctx, ['cat', 'home/a.txt']);
    expect(Buffer.from(cat.stdout.text(), 'utf8')).toEqual(Buffer.from([0x61, 0x00, 0x62]));
  });

  test('roots add / rm', async () => {
    const seen: string[] = [];
    const { ctx, stdout } = await testContext(
      filesFetch({
        'POST /api/files/roots': async (req) => {
          seen.push(await req.text());
          return json({ root: { ...ROOT, id: 'new-root' } }, 201);
        },
      }),
      { json: true }
    );
    await files.run(ctx, ['roots', 'add', 'laptop', '/opt/src']);
    expect(seen[0]).toContain('/opt/src');
    expect(JSON.parse(stdout.text()).root.id).toBe('new-root');
  });

  test('unknown root is exit 4', async () => {
    const { ctx } = await testContext(filesFetch());
    const error = (await files
      .run(ctx, ['ls', 'missing/docs'])
      .catch((err) => err)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.exitCode).toBe(4);
  });

  test('rejects a missing subcommand', async () => {
    const { ctx } = await testContext(filesFetch());
    await expect(files.run(ctx, [])).rejects.toThrow(UsageError);
  });

  test('403 outside_roots is a permission error not login', async () => {
    const { ctx } = await testContext(
      filesFetch({
        'GET /api/files/raw': () => json({ error: 'outside_roots', code: 'outside_roots' }, 403),
      })
    );
    const error = (await files.run(ctx, ['cat', 'home/a.txt']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('outside_roots');
  });

  test('rejects .. in the path', async () => {
    const { ctx } = await testContext(filesFetch());
    await expect(files.run(ctx, ['ls', 'home/../etc'])).rejects.toThrow(UsageError);
  });
});
