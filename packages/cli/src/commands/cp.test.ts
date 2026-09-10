import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildContext } from '../core/context';
import { CliError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { command as cp } from './cp';

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjson(events: unknown[]): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
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

const job = {
  jobId: 'job-1',
  state: 'running',
  fromNodeId: NODE,
  toNodeId: NODE,
  destRootId: ROOT_ID,
  destPath: '/home/me',
  expanding: false,
  items: [{ relPath: 'a.txt', size: 3, state: 'done', transferredBytes: 3 }],
  currentIndex: 0,
  progress: { transferredBytes: 3, totalBytes: 3, ratePerSec: 1, etaSec: 0 },
};

interface RouterState {
  puts: Array<{ offset: string; length: string }>;
  bodies: Buffer[];
  mkdirs?: string[];
  deletes?: string[];
  statusGets?: number;
  putStatus?: number;
  contentAttempts?: number;
  noMkdir?: boolean;
  commitEvents?: unknown[];
  prepareEvents?: unknown[];
  events?: unknown[];
  jobGet?: unknown;
  listTruncated?: boolean;
}

function router(state: RouterState): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init as RequestInit);
    const url = new URL(request.url);
    const path = url.pathname.replace(new RegExp(`^/n/${NODE}`), '') || url.pathname;
    if (path === '/api/mesh/nodes') {
      return json({
        nodes: [{ id: NODE, name: 'office', publicKey: 'x', online: true, loggedIn: true }],
      });
    }
    if (path === '/api/auth/mode') return json({ mode: 'mesh', nodeId: NODE });
    if (path === '/api/files/roots') return json({ roots: [ROOT] });
    if (path === '/api/files/stat') {
      const target = url.searchParams.get('path') ?? '';
      if (target === '/home/me' || target.endsWith('/docs')) {
        return json({
          path: target,
          name: 'docs',
          type: 'dir',
          category: 'directory',
          size: 0,
          modifiedAt: null,
          mime: null,
          isSymlink: false,
        });
      }
      if (target.endsWith('a.txt')) {
        return json({
          path: target,
          name: 'a.txt',
          type: 'file',
          category: 'text',
          size: 3,
          modifiedAt: null,
          mime: 'text/plain',
          isSymlink: false,
        });
      }
      return json({ error: 'not_found', code: 'not_found' }, 404);
    }
    if (path === '/api/files/mkdir' && request.method === 'POST') {
      if (state.noMkdir) return json({ error: 'Not found' }, 404);
      const body = (await request.json()) as { path: string };
      if (!state.mkdirs) state.mkdirs = [];
      state.mkdirs.push(body.path);
      return json({ path: body.path, created: true });
    }
    if (path === '/api/files/upload/init') {
      return json({ uploadId: 'up-1', chunkSize: 8, ranged: true });
    }
    if (path === '/api/files/upload/up-1' && request.method === 'GET') {
      state.statusGets = (state.statusGets ?? 0) + 1;
      return json({ received: 8, complete: false, ranges: [[0, 8]] });
    }
    if (path === '/api/files/upload/up-1' && request.method === 'PUT') {
      if (state.putStatus === 409 && state.puts.length === 0) {
        state.puts.push({
          offset: url.searchParams.get('offset') ?? '',
          length: url.searchParams.get('length') ?? '',
        });
        return json({ error: 'offset_mismatch' }, 409);
      }
      state.puts.push({
        offset: url.searchParams.get('offset') ?? '',
        length: url.searchParams.get('length') ?? '',
      });
      state.bodies.push(Buffer.from(await request.arrayBuffer()));
      return json({ ok: true });
    }
    if (path === '/api/files/upload/up-1' && request.method === 'DELETE') {
      if (!state.deletes) state.deletes = [];
      state.deletes.push('upload');
      return new Response(null, { status: 204 });
    }
    if (path === '/api/files/upload/up-1/commit') {
      return ndjson(
        state.commitEvents ?? [
          { type: 'progress', transferred: 3, pct: 100, rate: '1 B/s' },
          { type: 'done', uploaded: '/home/me/a.txt' },
        ]
      );
    }
    if (path === '/api/files/download/prepare') {
      return ndjson(
        state.prepareEvents ?? [
          { type: 'progress', transferred: 3, pct: 100 },
          { type: 'done', downloadId: 'dl-1', size: 3, name: 'a.txt' },
        ]
      );
    }
    if (path === '/api/files/download/dl-1/content') {
      state.contentAttempts = (state.contentAttempts ?? 0) + 1;
      const range = request.headers.get('range');
      if (range === 'bytes=1-') {
        return new Response(Buffer.from('bc'), {
          status: 206,
          headers: { 'content-length': '2', 'content-range': 'bytes 1-2/3' },
        });
      }
      if (state.contentAttempts === 1 && range == null && state.putStatus === 206) {
        return new Response(Buffer.from('a'), { headers: { 'content-length': '3' } });
      }
      return new Response(Buffer.from('abc'), { headers: { 'content-length': '3' } });
    }
    if (path === '/api/files/download/dl-1' && request.method === 'DELETE') {
      if (!state.deletes) state.deletes = [];
      state.deletes.push('download');
      return new Response(null, { status: 204 });
    }
    if (path === '/api/files/list') {
      return json({
        path: url.searchParams.get('path'),
        truncated: state.listTruncated === true,
        entries: [
          {
            name: 'a.txt',
            path: '/home/me/a.txt',
            type: 'file',
            category: 'text',
            size: 3,
            modifiedAt: null,
            isSymlink: false,
          },
        ],
      });
    }
    if (path === '/api/transfer/grants')
      return json({ grantId: 'g1', token: 'tok', expiresAt: Date.now() + 1000 });
    if (path === '/api/transfer/jobs' && request.method === 'POST') return json({ job });
    if (path === '/api/transfer/jobs' && request.method === 'GET') return json({ jobs: [job] });
    if (path === '/api/transfer/jobs/job-1/events') {
      return ndjson(
        state.events ?? [
          { type: 'snapshot', job: { ...job, state: 'running' } },
          { type: 'state', jobId: 'job-1', state: 'done' },
          { type: 'end' },
        ]
      );
    }
    if (path === '/api/transfer/jobs/job-1' && request.method === 'GET') {
      return json({
        job: state.jobGet ?? {
          ...job,
          state: 'done',
          finishedAt: 1,
        },
      });
    }
    if (path === '/api/transfer/jobs/job-1' && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return json({ error: 'not_found', code: 'not_found' }, 404);
  };
}

async function testContext(fetchImpl: FetchLike, options: { json?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-cp-'));
  dirs.push(dir);
  const stdout = collector();
  const stderr = collector();
  const ctx = buildContext({
    entryFlag: ENTRY,
    node: null,
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
  return { ctx, stdout, stderr, dir };
}

async function writeSrc(name: string, body: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-src-'));
  dirs.push(tmp);
  const src = join(tmp, name);
  await writeFile(src, body);
  return src;
}

describe('vibeterm cp', () => {
  test('uploads a local file in chunks and commits', async () => {
    const src = await writeSrc('a.txt', 'abc');
    const state: RouterState = { puts: [], bodies: [] };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, [src, 'home/docs']);
    expect(state.puts.length).toBeGreaterThan(0);
    expect(Buffer.concat(state.bodies).toString('utf8')).toBe('abc');
    expect(state.mkdirs?.length).toBeGreaterThan(0);
  });

  test('downloads to a local path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dst-'));
    dirs.push(tmp);
    const dest = join(tmp, 'out.txt');
    const { ctx } = await testContext(router({ puts: [], bodies: [] }));
    await cp.run(ctx, ['home/a.txt', dest]);
    expect(await readFile(dest, 'utf8')).toBe('abc');
  });

  test('node-to-node follows NDJSON events', async () => {
    const { ctx, stdout } = await testContext(router({ puts: [], bodies: [] }), { json: true });
    await cp.run(ctx, ['office:home/a.txt', 'office:home/docs']);
    expect(stdout.text()).toContain('"type":"progress"');
    expect(stdout.text()).toContain('"type":"done"');
  });

  test('jobs ls and cancel', async () => {
    const { ctx, stdout } = await testContext(router({ puts: [], bodies: [] }), { json: true });
    await cp.run(ctx, ['jobs', 'ls']);
    expect(JSON.parse(stdout.text()).jobs[0].jobId).toBe('job-1');
    const cancel = await testContext(router({ puts: [], bodies: [] }), { json: true });
    await cp.run(cancel.ctx, ['jobs', 'cancel', 'job-1']);
    expect(JSON.parse(cancel.stdout.text()).cancelled).toBe('job-1');
  });

  test('rejects local-to-local', async () => {
    const { ctx } = await testContext(router({ puts: [], bodies: [] }));
    await expect(cp.run(ctx, ['./a', './b'])).rejects.toThrow(UsageError);
  });

  test('rejects directory without -r', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dir-'));
    dirs.push(tmp);
    const { ctx } = await testContext(router({ puts: [], bodies: [] }));
    await expect(cp.run(ctx, [tmp, 'home/docs'])).rejects.toThrow(UsageError);
  });

  test('mkdir is memoised per directory on recursive upload', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-tree-'));
    dirs.push(tmp);
    await mkdir(join(tmp, 'sub'), { recursive: true });
    await mkdir(join(tmp, 'empty'), { recursive: true });
    await writeFile(join(tmp, 'sub', 'a.txt'), 'abc');
    await writeFile(join(tmp, 'sub', 'b.txt'), 'abc');
    const state: RouterState = { puts: [], bodies: [] };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, ['-r', tmp, 'home/docs']);
    const mkdirs = state.mkdirs ?? [];
    const unique = [...new Set(mkdirs)];
    expect(unique.length).toBe(mkdirs.length);
    expect(mkdirs.some((path) => path.endsWith('/empty') || path.includes('/empty'))).toBe(true);
  });

  test('recursive upload fails up front when mkdir is missing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-old-'));
    dirs.push(tmp);
    await writeFile(join(tmp, 'a.txt'), 'abc');
    const { ctx } = await testContext(router({ puts: [], bodies: [], noMkdir: true }));
    await expect(cp.run(ctx, ['-r', tmp, 'home/docs'])).rejects.toThrow(
      /does not support POST \/api\/files\/mkdir/
    );
  });

  test('PUT 409 asks status and refills the gap', async () => {
    const src = await writeSrc('a.txt', 'abcdefghijklmnop');
    const state: RouterState = { puts: [], bodies: [], putStatus: 409 };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, [src, 'home/docs']);
    expect(state.statusGets).toBeGreaterThan(0);
    expect(state.puts.length).toBeGreaterThan(1);
  });

  test('Range/206 resume on truncated download', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dst-'));
    dirs.push(tmp);
    const dest = join(tmp, 'out.txt');
    const state: RouterState = { puts: [], bodies: [], putStatus: 206 };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, ['home/a.txt', dest]);
    expect(await readFile(dest, 'utf8')).toBe('abc');
    expect(state.contentAttempts).toBeGreaterThan(1);
  });

  test('commit error event fails the copy', async () => {
    const src = await writeSrc('a.txt', 'abc');
    const { ctx } = await testContext(
      router({
        puts: [],
        bodies: [],
        commitEvents: [{ type: 'error', code: 'disk_full', detail: 'disk full' }],
      })
    );
    await expect(cp.run(ctx, [src, 'home/docs'])).rejects.toThrow(/disk full/);
  });

  test('prepare error event fails the copy', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dst-'));
    dirs.push(tmp);
    const { ctx } = await testContext(
      router({
        puts: [],
        bodies: [],
        prepareEvents: [{ type: 'error', code: 'too_large', detail: 'file too large' }],
      })
    );
    await expect(cp.run(ctx, ['home/a.txt', join(tmp, 'out.txt')])).rejects.toThrow(
      /file too large/
    );
  });

  test('events end without a terminal state polls GET job', async () => {
    const { ctx, stdout } = await testContext(
      router({
        puts: [],
        bodies: [],
        events: [{ type: 'end' }],
        jobGet: { ...job, state: 'done', finishedAt: 99 },
      }),
      { json: true }
    );
    await cp.run(ctx, ['office:home/a.txt', 'office:home/docs']);
    expect(stdout.text()).toContain('"type":"done"');
  });

  test('skip on conflict exits 0 unless --fail-on-skip', async () => {
    const src = await writeSrc('a.txt', 'abc');
    const { ctx, stdout } = await testContext(router({ puts: [], bodies: [] }), { json: true });
    const code = await cp.run(ctx, [src, 'home/a.txt']);
    expect(code).toBeUndefined();
    expect(stdout.text()).toContain('"skipped":1');
    const fail = await testContext(router({ puts: [], bodies: [] }), { json: true });
    const failed = await cp.run(fail.ctx, [src, 'home/a.txt', '--fail-on-skip']);
    expect(failed).toBe(1);
  });

  test('overwrite replaces an existing remote file', async () => {
    const src = await writeSrc('a.txt', 'abc');
    const state: RouterState = { puts: [], bodies: [] };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, [src, 'home/a.txt', '--on-conflict', 'overwrite']);
    expect(state.puts.length).toBeGreaterThan(0);
  });

  test('truncated listing exits 1', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dst-'));
    dirs.push(tmp);
    const { ctx, stdout } = await testContext(
      router({ puts: [], bodies: [], listTruncated: true }),
      { json: true }
    );
    const code = await cp.run(ctx, ['-r', 'home/docs', tmp]);
    expect(code).toBe(1);
    expect(stdout.text()).toContain('"truncated":true');
  });

  test('node-to-node rename dest is rejected', async () => {
    const { ctx } = await testContext(router({ puts: [], bodies: [] }));
    await expect(cp.run(ctx, ['office:home/a.txt', 'office:home/renamed.txt'])).rejects.toThrow(
      UsageError
    );
  });

  test('skips symlinks in a local tree', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-link-'));
    dirs.push(tmp);
    await writeFile(join(tmp, 'a.txt'), 'abc');
    await symlink(join(tmp, 'a.txt'), join(tmp, 'link.txt'));
    const state: RouterState = { puts: [], bodies: [] };
    const { ctx, stdout } = await testContext(router(state), { json: true });
    await cp.run(ctx, ['-r', tmp, 'home/docs']);
    expect(stdout.text()).toContain('"reason":"symlink"');
  });
});
