import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildContext } from '../core/context';
import { CliError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { command as port } from './port';

const ENTRY = 'http://entry.example:9883';
const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
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

const MAP = {
  id: 'm1',
  name: 'db',
  listenHost: '127.0.0.1',
  listenPort: 15432,
  targetNodeId: NODE_B,
  targetHost: '127.0.0.1',
  targetPort: 5432,
  paused: false,
  state: 'listening',
  activeConnections: 1,
  totalConnections: 4,
  bytesIn: 10,
  bytesOut: 20,
  createdAt: 1,
  updatedAt: 2,
};

function portFetch(options: { failMap?: boolean; exportRemoved?: boolean } = {}): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(input, init as RequestInit);
    const url = new URL(request.url);
    const match = /^\/n\/([0-9a-f]{32})(\/.*)$/.exec(url.pathname);
    const nodeId = match ? match[1] : 'self';
    const path = match ? match[2] : url.pathname;
    calls.push(`${request.method} ${nodeId} ${path}`);
    if (path === '/api/mesh/nodes') {
      return json({
        nodes: [
          { id: NODE_A, name: 'office', publicKey: 'x', online: true, loggedIn: true },
          { id: NODE_B, name: 'lab', publicKey: 'y', online: true, loggedIn: true },
        ],
      });
    }
    if (path === '/api/auth/mode') return json({ mode: 'mesh', nodeId: NODE_A });
    if (path === '/api/portmap/exports' && request.method === 'POST') {
      return json({
        export: {
          mapId: 'm1',
          fromNodeId: NODE_A,
          host: '127.0.0.1',
          port: 5432,
          enabled: true,
          createdAt: 1,
        },
      });
    }
    if (path === '/api/portmap' && request.method === 'POST') {
      if (options.failMap) return json({ error: { code: 'port_in_use' } }, 409);
      return json({ map: MAP });
    }
    if (path === '/api/portmap' && request.method === 'GET') {
      return json({ maps: options.failMap ? [] : [MAP] });
    }
    if (path === '/api/portmap/m1' && request.method === 'DELETE') {
      return json({ ok: true, exportRemoved: options.exportRemoved ?? true });
    }
    if (path === '/api/portmap/m1' && request.method === 'PATCH') {
      const body = (await request.json()) as { paused?: boolean };
      return json({
        map: { ...MAP, paused: body.paused === true, state: body.paused ? 'paused' : 'listening' },
      });
    }
    if (path === '/api/portmap/exports/m1' && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/api/portmap/probe')) {
      return json({
        host: url.searchParams.get('host'),
        port: Number(url.searchParams.get('port')),
        free: true,
        reserved: false,
        usedByMapId: null,
      });
    }
    if (path.startsWith('/api/portmap/target-probe')) {
      return json({
        host: url.searchParams.get('host'),
        port: Number(url.searchParams.get('port')),
        listening: true,
      });
    }
    return json({ error: 'not_found' }, 404);
  };
  return { fetch: fetchImpl, calls };
}

async function testContext(fetchImpl: FetchLike, options: { json?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-port-'));
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
  return { ctx, stdout, stderr };
}

describe('vibeterm port', () => {
  test('map creates the export then the listen map', async () => {
    const fake = portFetch();
    const { ctx, stdout } = await testContext(fake.fetch, { json: true });
    await port.run(ctx, ['map', '15432', 'lab:127.0.0.1:5432', '--name', 'db']);
    expect(
      fake.calls.some((row) => row.includes('POST') && row.includes('/api/portmap/exports'))
    ).toBe(true);
    expect(fake.calls.some((row) => row.includes('POST') && row.endsWith('/api/portmap'))).toBe(
      true
    );
    expect(JSON.parse(stdout.text()).map.id).toBe('m1');
  });

  test('map rolls back the export when the listen map is rejected', async () => {
    const fake = portFetch({ failMap: true });
    const { ctx } = await testContext(fake.fetch);
    const error = (await port
      .run(ctx, ['map', '15432', 'lab:127.0.0.1:5432'])
      .catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(
      fake.calls.some((row) => row.includes('DELETE') && row.includes('/api/portmap/exports/m1'))
    ).toBe(true);
  });

  test('ls includes live counters', async () => {
    const fake = portFetch();
    const { ctx, stdout } = await testContext(fake.fetch, { json: true });
    await port.run(ctx, ['ls']);
    expect(JSON.parse(stdout.text()).maps[0].activeConnections).toBe(1);
  });

  test('rm / pause / probe', async () => {
    const fake = portFetch({ exportRemoved: true });
    const { ctx, stdout } = await testContext(fake.fetch, { json: true });
    await port.run(ctx, ['rm', 'm1']);
    expect(JSON.parse(stdout.text()).exportRemoved).toBe(true);
    const pause = await testContext(portFetch().fetch, { json: true });
    await port.run(pause.ctx, ['pause', 'm1']);
    expect(JSON.parse(pause.stdout.text()).map.paused).toBe(true);
    const probe = await testContext(portFetch().fetch, { json: true });
    await port.run(probe.ctx, ['probe', 'lab:127.0.0.1:5432']);
    const body = JSON.parse(probe.stdout.text()) as {
      listen: { free: boolean };
      target: { listening: boolean };
    };
    expect(body.listen.free).toBe(true);
    expect(body.target.listening).toBe(true);
  });

  test('rejects a bad map spec', async () => {
    const { ctx } = await testContext(portFetch().fetch);
    expect(port.run(ctx, ['map', '80'])).rejects.toThrow(UsageError);
  });
});
