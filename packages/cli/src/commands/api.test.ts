import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildContext } from '../core/context';
import { AuthError, CliError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { command as api, parseMethod, parsePath, resolveBody } from './api';

const ENTRY = 'http://entry.example:9883';
const NODE = 'a'.repeat(32);
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

async function testContext(fetchImpl: FetchLike, options: { json?: boolean; node?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-api-'));
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
  return { ctx, stdout, stderr, dir };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api argument parsing', () => {
  test('method is case-insensitive and validated', () => {
    expect(parseMethod('get')).toBe('GET');
    expect(() => parseMethod('FETCH')).toThrow(UsageError);
    expect(() => parseMethod(undefined)).toThrow(UsageError);
  });

  test('path must be absolute', () => {
    expect(parsePath('/api/system/info')).toBe('/api/system/info');
    expect(() => parsePath('api/system/info')).toThrow(UsageError);
    expect(() => parsePath(undefined)).toThrow(UsageError);
  });

  test('--body accepts literal JSON and rejects garbage', async () => {
    expect(await resolveBody('{"a":1}')).toBe('{"a":1}');
    expect(resolveBody('{oops')).rejects.toThrow(UsageError);
    expect(await resolveBody(undefined)).toBeUndefined();
  });

  test('--body @file reads the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-body-'));
    dirs.push(dir);
    const path = join(dir, 'body.json');
    await writeFile(path, '{"name":"laptop"}');
    expect(await resolveBody(`@${path}`)).toBe('{"name":"laptop"}');
  });
});

describe('vibeterm api', () => {
  test('pretty-prints JSON by default', async () => {
    const { ctx, stdout } = await testContext(async () => jsonResponse({ version: '2.0.8' }));
    await api.run(ctx, ['GET', '/api/system/info']);
    expect(stdout.text()).toBe('{\n  "version": "2.0.8"\n}\n');
  });

  test('--json prints one compact line', async () => {
    const { ctx, stdout } = await testContext(async () => jsonResponse({ version: '2.0.8' }), {
      json: true,
    });
    await api.run(ctx, ['GET', '/api/system/info']);
    expect(stdout.text()).toBe('{"version":"2.0.8"}\n');
  });

  test('--raw writes the bytes untouched', async () => {
    const { ctx, stdout } = await testContext(
      async () => new Response('plain bytes', { headers: { 'content-type': 'text/plain' } })
    );
    await api.run(ctx, ['GET', '/api/files/read', '--raw']);
    expect(stdout.text()).toBe('plain bytes');
  });

  test('sends the body with a JSON content type', async () => {
    const seen: Array<{ method?: string; body?: unknown; type: string | null }> = [];
    const { ctx } = await testContext(async (_url, init) => {
      seen.push({
        method: init?.method,
        body: init?.body,
        type: new Headers(init?.headers).get('content-type'),
      });
      return jsonResponse({ ok: true });
    });
    await api.run(ctx, ['POST', '/api/devices', '--body', '{"name":"laptop"}']);
    expect(seen).toEqual([{ method: 'POST', body: '{"name":"laptop"}', type: 'application/json' }]);
  });

  test('--node routes through /n/<id>', async () => {
    let url = '';
    const { ctx } = await testContext(
      async (requested) => {
        url = requested;
        return jsonResponse({ ok: true });
      },
      { node: NODE }
    );
    await api.run(ctx, ['GET', '/api/devices']);
    expect(url).toBe(`${ENTRY}/n/${NODE}/api/devices`);
  });

  test('a non-2xx status fails with exit 1 and the body', async () => {
    const { ctx } = await testContext(async () => jsonResponse({ error: 'boom' }, 500));
    const error = (await api.run(ctx, ['GET', '/api/devices']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('boom');
  });

  test('401 fails with exit 3 and a login hint', async () => {
    const { ctx } = await testContext(
      async () => jsonResponse({ error: 'NODE_LOGIN_REQUIRED' }, 401),
      { node: NODE }
    );
    const error = (await api.run(ctx, ['GET', '/api/devices']).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe(`run: vibeterm login --node ${NODE}`);
  });

  test('rejects extra positionals', async () => {
    const { ctx } = await testContext(async () => jsonResponse({}));
    expect(api.run(ctx, ['GET', '/api/devices', 'extra'])).rejects.toThrow(UsageError);
  });
});
