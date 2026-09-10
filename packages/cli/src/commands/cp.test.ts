import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildContext } from '../core/context';
import { UsageError } from '../core/errors';
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

function router(state: {
  puts: Array<{ offset: string; length: string }>;
  bodies: Buffer[];
}): FetchLike {
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
    if (path === '/api/files/upload/init') {
      return json({ uploadId: 'up-1', chunkSize: 8, ranged: true });
    }
    if (path === '/api/files/upload/up-1' && request.method === 'PUT') {
      state.puts.push({
        offset: url.searchParams.get('offset') ?? '',
        length: url.searchParams.get('length') ?? '',
      });
      state.bodies.push(Buffer.from(await request.arrayBuffer()));
      return json({ ok: true });
    }
    if (path === '/api/files/upload/up-1/commit') {
      return ndjson([
        { type: 'progress', transferred: 3, pct: 100, rate: '1 B/s' },
        { type: 'done', uploaded: '/home/me/a.txt' },
      ]);
    }
    if (path === '/api/files/download/prepare') {
      return ndjson([
        { type: 'progress', transferred: 3, pct: 100 },
        { type: 'done', downloadId: 'dl-1', size: 3, name: 'a.txt' },
      ]);
    }
    if (path === '/api/files/download/dl-1/content') {
      return new Response(Buffer.from('abc'), { headers: { 'content-length': '3' } });
    }
    if (path === '/api/files/download/dl-1' && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path === '/api/transfer/grants')
      return json({ grantId: 'g1', token: 'tok', expiresAt: Date.now() + 1000 });
    if (path === '/api/transfer/jobs' && request.method === 'POST') return json({ job });
    if (path === '/api/transfer/jobs' && request.method === 'GET') return json({ jobs: [job] });
    if (path === '/api/transfer/jobs/job-1/events') {
      return ndjson([
        { type: 'snapshot', job: { ...job, state: 'running' } },
        { type: 'state', jobId: 'job-1', state: 'done' },
        { type: 'end' },
      ]);
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

describe('vibeterm cp', () => {
  test('uploads a local file in chunks and commits', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-src-'));
    dirs.push(tmp);
    const src = join(tmp, 'a.txt');
    await writeFile(src, 'abc');
    const state = { puts: [] as Array<{ offset: string; length: string }>, bodies: [] as Buffer[] };
    const { ctx } = await testContext(router(state));
    await cp.run(ctx, [src, 'home/docs']);
    expect(state.puts.length).toBeGreaterThan(0);
    expect(Buffer.concat(state.bodies).toString('utf8')).toBe('abc');
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
    expect(cp.run(ctx, ['./a', './b'])).rejects.toThrow(UsageError);
  });

  test('rejects directory without -r', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'vibeterm-cli-dir-'));
    dirs.push(tmp);
    const { ctx } = await testContext(router({ puts: [], bodies: [] }));
    expect(cp.run(ctx, [tmp, 'home/docs'])).rejects.toThrow(UsageError);
  });
});
