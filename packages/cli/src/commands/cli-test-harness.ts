// 命令组单测共用的假 fetch / ctx。不进 bundle（只被 *.test.ts import）。

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { type CliContext, buildContext } from '../core/context';
import type { FetchLike } from '../core/http';

export const ENTRY = 'http://entry.example:9883';
export const NODE = 'a'.repeat(32);

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function collector(): { stream: Writable; text: () => string } {
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

export function routeFetch(
  routes: Record<string, (url: URL, init?: RequestInit) => Response | object>
): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse({ error: 'Not found' }, 404);
    const result = handler(url, init);
    return result instanceof Response ? result : jsonResponse(result);
  };
}

export async function testContext(
  fetchImpl: FetchLike,
  options: { json?: boolean; node?: string } = {}
): Promise<{ ctx: CliContext; stdout: ReturnType<typeof collector>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-t3-'));
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
  return { ctx, stdout, dir };
}

export function meshNode(
  partial: Partial<{ id: string; name: string }> & Record<string, unknown> = {}
) {
  return {
    id: NODE,
    name: 'office',
    publicKey: 'pk',
    online: true,
    reach: 'lan',
    transport: 'ws-secure',
    rttMs: 12,
    version: '2.0.8',
    direct_capable: true,
    loggedIn: true,
    ...partial,
  };
}
