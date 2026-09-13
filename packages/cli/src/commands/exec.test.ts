import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, CliError, NetworkError, NotFoundError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { jsonResponse, testContext } from './cli-test-harness';
import { command as exec } from './exec';

const dirs: string[] = [];
const DEVICE = {
  id: 'dev-1',
  name: 'laptop',
  type: 'local',
  sortOrder: 0,
  authMode: 'auto',
  createdAt: '',
  updatedAt: '',
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ndjson(events: unknown[], status = 200): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function execFetch(
  events: unknown[],
  onBody?: (body: unknown) => void,
  extra: Record<string, (url: URL, init?: RequestInit) => Response | object> = {}
): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (path === '/api/devices') return jsonResponse({ devices: [DEVICE] });
    if (path === '/api/mesh/nodes') return jsonResponse({ nodes: [] });
    if (path === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
    const extraHandler = extra[`${method} ${path}`];
    if (extraHandler) {
      const result = extraHandler(url, init);
      return result instanceof Response ? result : jsonResponse(result);
    }
    if (method === 'POST' && path === '/api/exec') {
      onBody?.(JSON.parse(String(init?.body ?? '{}')));
      return ndjson(events);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  };
}

describe('vibeterm exec', () => {
  test('posts argv and returns a JSON object with the remote exit code', async () => {
    let posted: unknown;
    const { ctx, stdout } = await testContext(
      execFetch(
        [
          { type: 'start', pid: 9, device: { id: 'dev-1', type: 'local' } },
          { type: 'stdout', base64: Buffer.from('hi\n').toString('base64') },
          {
            type: 'exit',
            code: 7,
            signal: null,
            durationMs: 12,
            truncated: { stdout: false, stderr: false },
          },
        ],
        (body) => {
          posted = body;
        }
      )
    );
    const code = await exec.run(ctx, ['laptop', '--', 'echo', 'hi']);
    expect(posted).toMatchObject({
      deviceId: 'dev-1',
      argv: ['echo', 'hi'],
    });
    expect(posted).not.toHaveProperty('timeoutMs');
    expect(code).toBe(7);
    expect(JSON.parse(stdout.text())).toMatchObject({
      exitCode: 7,
      stdout: 'hi\n',
      reason: 'exit',
    });
  });

  test('--shell --cwd --env and @file stdin go into the body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-'));
    dirs.push(dir);
    const file = join(dir, 'in.txt');
    await writeFile(file, 'payload');
    let posted: Record<string, unknown> = {};
    const { ctx } = await testContext(
      execFetch(
        [
          {
            type: 'exit',
            code: 0,
            signal: null,
            durationMs: 1,
            truncated: { stdout: false, stderr: false },
          },
        ],
        (body) => {
          posted = body as Record<string, unknown>;
        }
      )
    );
    await exec.run(ctx, [
      'laptop',
      '--cwd',
      '/tmp',
      '--env',
      'FOO=bar',
      '--stdin-file',
      file,
      '--shell',
      '--',
      'cat',
    ]);
    expect(posted.cwd).toBe('/tmp');
    expect(posted.env).toEqual({ FOO: 'bar' });
    expect(posted.shell).toBe(true);
    expect(posted.argv).toEqual(['cat']);
    expect(posted.stdin).toEqual({ text: 'payload' });
  });

  test('@path as the last pre -- token is stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-at-'));
    dirs.push(dir);
    const file = join(dir, 's.sh');
    await writeFile(file, 'echo z');
    let posted: Record<string, unknown> = {};
    const { ctx } = await testContext(
      execFetch(
        [
          {
            type: 'exit',
            code: 0,
            signal: null,
            durationMs: 1,
            truncated: { stdout: false, stderr: false },
          },
        ],
        (body) => {
          posted = body as Record<string, unknown>;
        }
      )
    );
    await exec.run(ctx, ['laptop', `@${file}`, '--', 'bash']);
    expect(posted.stdin).toEqual({ text: 'echo z' });
    expect(posted.argv).toEqual(['bash']);
  });

  test('--json --stream emits NDJSON events', async () => {
    const events = [
      { type: 'start', pid: 1, device: { id: 'dev-1', type: 'local' } },
      {
        type: 'exit',
        code: 0,
        signal: null,
        durationMs: 3,
        truncated: { stdout: false, stderr: false },
      },
    ];
    const { ctx, stdout } = await testContext(execFetch(events), { json: true });
    await exec.run(ctx, ['laptop', '--stream', '--', 'true']);
    const lines = stdout
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((row) => row.type)).toEqual(['start', 'exit']);
  });

  test('timeout events exit 124', async () => {
    const { ctx } = await testContext(
      execFetch([
        { type: 'error', code: 'exec_timeout', message: 'timed out' },
        {
          type: 'exit',
          code: null,
          signal: 'SIGTERM',
          durationMs: 5,
          truncated: { stdout: false, stderr: false },
        },
      ])
    );
    expect(await exec.run(ctx, ['laptop', '--', 'sleep', '9'])).toBe(124);
  });

  test('400 invalid_body is a usage error', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () =>
          jsonResponse({ code: 'invalid_body', message: 'argv required' }, 400),
      })
    );
    await expect(exec.run(ctx, ['laptop', '--', 'true'])).rejects.toBeInstanceOf(UsageError);
  });

  test('400 device_not_found is exit 4', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () =>
          jsonResponse({ code: 'device_not_found', message: 'no such device' }, 400),
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error.exitCode).toBe(4);
  });

  test('400 exec_unsupported_device is exit 5', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () =>
          jsonResponse({ code: 'exec_unsupported_device', message: 'password ssh' }, 400),
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
  });

  test('401 is exit 3', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () => jsonResponse({ error: 'UNAUTHORIZED' }, 401),
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
  });

  test('network timeout is exit 5', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () => {
          const err = new Error('aborted');
          err.name = 'TimeoutError';
          throw err;
        },
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
  });

  test('non-JSON 404 is exit 4', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () => new Response('nope', { status: 404 }),
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.exitCode).toBe(4);
  });

  test('400 non-JSON body is exit 5, not 1', async () => {
    const { ctx } = await testContext(
      execFetch([], undefined, {
        'POST /api/exec': () => new Response('plain 400', { status: 400 }),
      })
    );
    const error = (await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err)) as CliError;
    expect(error.exitCode).toBe(5);
    expect(error).toBeInstanceOf(CliError);
  });

  test('explicit --timeout 30000 is sent as timeoutMs', async () => {
    let posted: unknown;
    const { ctx } = await testContext(
      execFetch(
        [
          {
            type: 'exit',
            code: 0,
            signal: null,
            durationMs: 1,
            truncated: { stdout: false, stderr: false },
          },
        ],
        (body) => {
          posted = body;
        }
      ),
      { timeoutMs: 30_000 }
    );
    await exec.run(ctx, ['laptop', '--', 'true']);
    expect(posted).toMatchObject({ timeoutMs: 30_000 });
  });

  test('--shell rejects extra argv', async () => {
    const { ctx } = await testContext(execFetch([]));
    await expect(exec.run(ctx, ['laptop', '--shell', '--', 'echo', 'a'])).rejects.toBeInstanceOf(
      UsageError
    );
  });
});
