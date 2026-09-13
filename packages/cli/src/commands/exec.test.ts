import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, CliError, NetworkError, NotFoundError, UsageError } from '../core/errors';
import { EXEC_STREAM_CLOSED, ExecStreamClosedError } from '../core/exec-client';
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

  test('--script sends file as stdin with /bin/sh -s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-script-'));
    dirs.push(dir);
    const file = join(dir, 'run.sh');
    await writeFile(file, 'echo from-script\n');
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
    await exec.run(ctx, ['laptop', '--script', file]);
    expect(posted.argv).toEqual(['/bin/sh', '-s']);
    expect(posted.stdin).toEqual({ text: 'echo from-script\n' });
    expect(posted.shell).toBeUndefined();
  });

  test('--script uses bash -s for a bash shebang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-shebang-'));
    dirs.push(dir);
    const file = join(dir, 'run.sh');
    await writeFile(file, '#!/usr/bin/env bash\necho hi\n');
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
    await exec.run(ctx, ['laptop', '--script', file]);
    expect(posted.argv).toEqual(['bash', '-s']);
  });

  test('--script with unknown shebang falls back to /bin/sh -s and warns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-py-'));
    dirs.push(dir);
    const file = join(dir, 'run.py');
    await writeFile(file, '#!/usr/bin/python3\nprint(1)\n');
    let posted: Record<string, unknown> = {};
    const { ctx, stderr } = await testContext(
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
    await exec.run(ctx, ['laptop', '--script', file]);
    expect(posted.argv).toEqual(['/bin/sh', '-s']);
    expect(stderr.text()).toContain('python3');
    expect(stderr.text()).toContain('/bin/sh -s');
  });

  test('--interpreter overrides shebang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-int-'));
    dirs.push(dir);
    const file = join(dir, 'run.sh');
    await writeFile(file, '#!/bin/bash\necho hi\n');
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
    await exec.run(ctx, ['laptop', '--script', file, '--interpreter', '/bin/zsh']);
    expect(posted.argv).toEqual(['/bin/zsh', '-s']);
  });

  test('--script is exclusive with argv, --shell, and stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-excl-'));
    dirs.push(dir);
    const file = join(dir, 'run.sh');
    await writeFile(file, 'echo x\n');
    const { ctx } = await testContext(execFetch([]));
    await expect(exec.run(ctx, ['laptop', '--script', file, '--', 'true'])).rejects.toBeInstanceOf(
      UsageError
    );
    await expect(exec.run(ctx, ['laptop', '--script', file, '--shell'])).rejects.toBeInstanceOf(
      UsageError
    );
    await expect(exec.run(ctx, ['laptop', '--script', file, '--stdin'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('--script over the stdin cap points at vibeterm cp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-big-'));
    dirs.push(dir);
    const file = join(dir, 'big.sh');
    await writeFile(file, 'x'.repeat(768 * 1024 + 1));
    const { ctx } = await testContext(execFetch([]));
    const error = await exec.run(ctx, ['laptop', '--script', file]).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('vibeterm cp');
  });

  test('--max-bytes is sent on the request body', async () => {
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
      )
    );
    await exec.run(ctx, ['laptop', '--max-bytes', '2048', '--', 'true']);
    expect(posted).toMatchObject({ maxBytes: 2048 });
  });

  test('--tail keeps the last N bytes in JSON stdout', async () => {
    const { ctx, stdout } = await testContext(
      execFetch([
        { type: 'stdout', base64: Buffer.from('abcdefghij').toString('base64') },
        {
          type: 'exit',
          code: 0,
          signal: null,
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        },
      ])
    );
    await exec.run(ctx, ['laptop', '--tail', '4', '--', 'true']);
    expect(JSON.parse(stdout.text())).toMatchObject({
      stdout: 'ghij',
      truncated: { stdout: true, stderr: false },
      exitCode: 0,
    });
  });

  test('--stdout-file writes bytes and omits the inline string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-out-'));
    dirs.push(dir);
    const out = join(dir, 'stdout.txt');
    const { ctx, stdout } = await testContext(
      execFetch([
        { type: 'stdout', base64: Buffer.from('file-payload').toString('base64') },
        {
          type: 'exit',
          code: 0,
          signal: null,
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        },
      ])
    );
    await exec.run(ctx, ['laptop', '--stdout-file', out, '--', 'true']);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload.stdout).toBeUndefined();
    expect(payload.stdoutPath).toBe(out);
    expect(payload.stdoutBytes).toBe(12);
    expect(payload.stderr).toBe('');
    expect(await readFile(out, 'utf8')).toBe('file-payload');
  });

  test('inline JSON over 64 KiB hints --tail / --stdout-file on stderr', async () => {
    const blob = 'a'.repeat(64 * 1024 + 1);
    const { ctx, stderr } = await testContext(
      execFetch([
        { type: 'stdout', base64: Buffer.from(blob).toString('base64') },
        {
          type: 'exit',
          code: 0,
          signal: null,
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        },
      ])
    );
    await exec.run(ctx, ['laptop', '--', 'true']);
    expect(stderr.text()).toContain('--tail');
    expect(stderr.text()).toContain('--stdout-file');
  });

  test('stream death prints EXEC_STREAM_CLOSED JSON and throws NetworkError', async () => {
    const { ctx, stdout } = await testContext(async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/devices') return jsonResponse({ devices: [DEVICE] });
      if (url.pathname === '/api/mesh/nodes') return jsonResponse({ nodes: [] });
      if (url.pathname === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/exec') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ type: 'start', pid: 1, device: { id: 'dev-1', type: 'local' } })}\n`
                )
              );
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
        );
      }
      return jsonResponse({ error: 'Not found' }, 404);
    });
    const error = await exec.run(ctx, ['laptop', '--', 'true']).catch((err) => err);
    expect(error).toBeInstanceOf(ExecStreamClosedError);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as ExecStreamClosedError).exitCode).toBe(5);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: EXEC_STREAM_CLOSED,
      reason: 'terminated',
    });
    expect(typeof payload.elapsedMs).toBe('number');
  });

  test('--json --stream drops ping events', async () => {
    const events = [
      { type: 'ping', t: 1 },
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
    expect(lines.map((row) => row.type)).toEqual(['exit']);
  });

  test('--stdout-file is mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-mode-'));
    dirs.push(dir);
    const out = join(dir, 'stdout.txt');
    const { ctx } = await testContext(
      execFetch([
        { type: 'stdout', base64: Buffer.from('secret').toString('base64') },
        {
          type: 'exit',
          code: 0,
          signal: null,
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        },
      ])
    );
    await exec.run(ctx, ['laptop', '--stdout-file', out, '--', 'true']);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });

  test('missing --stdout-file parent dir is usage error before the request', async () => {
    let posted = false;
    const { ctx } = await testContext(
      execFetch([], () => {
        posted = true;
      })
    );
    const error = (await exec
      .run(ctx, ['laptop', '--stdout-file', '/nonexistent-dir-xyz-vt/out.txt', '--', 'true'])
      .catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('cannot open --stdout-file');
    expect(posted).toBe(false);
  });

  test('--tail 0 is a usage error and does not truncate --stdout-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-tail0-'));
    dirs.push(dir);
    const out = join(dir, 'existing.log');
    await writeFile(out, 'keep-me');
    let posted = false;
    const { ctx } = await testContext(
      execFetch([], () => {
        posted = true;
      })
    );
    const error = await exec
      .run(ctx, ['laptop', '--tail', '0', '--stdout-file', out, '--', 'true'])
      .catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect(posted).toBe(false);
    expect(await readFile(out, 'utf8')).toBe('keep-me');
  });

  test('768 KiB binary stdin is rejected client-side with a cp hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-b64-'));
    dirs.push(dir);
    const file = join(dir, 'blob.bin');
    await writeFile(file, Buffer.alloc(768 * 1024, 0xff));
    let posted = false;
    const { ctx } = await testContext(
      execFetch([], () => {
        posted = true;
      })
    );
    const error = (await exec
      .run(ctx, ['laptop', '--stdin-file', file, '--', 'cat'])
      .catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('vibeterm cp');
    expect(posted).toBe(false);
  });

  test('stdin that inflates past the JSON body cap is rejected with a cp hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-quotes-'));
    dirs.push(dir);
    const file = join(dir, 'quotes.txt');
    await writeFile(file, '"'.repeat(740 * 1024));
    let posted = false;
    const { ctx } = await testContext(
      execFetch([], () => {
        posted = true;
      })
    );
    const error = (await exec
      .run(ctx, ['laptop', '--stdin-file', file, '--', 'cat'])
      .catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('request body is');
    expect(error.message).toContain('1 MiB');
    expect(error.message).toContain('vibeterm cp');
    expect(posted).toBe(false);
  });

  test('stream death JSON includes file paths and bytes received', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-exec-closed-'));
    dirs.push(dir);
    const out = join(dir, 'partial.txt');
    const { ctx, stdout } = await testContext(async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/devices') return jsonResponse({ devices: [DEVICE] });
      if (url.pathname === '/api/mesh/nodes') return jsonResponse({ nodes: [] });
      if (url.pathname === '/api/auth/mode') return jsonResponse({ nodeId: 'self', mode: 'none' });
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname === '/api/exec') {
        let pulled = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!pulled) {
                pulled = true;
                controller.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({ type: 'stdout', base64: Buffer.from('partial').toString('base64') })}\n`
                  )
                );
                return;
              }
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
        );
      }
      return jsonResponse({ error: 'Not found' }, 404);
    });
    const error = await exec
      .run(ctx, ['laptop', '--stdout-file', out, '--', 'true'])
      .catch((err) => err);
    expect(error).toBeInstanceOf(ExecStreamClosedError);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: EXEC_STREAM_CLOSED,
      reason: 'terminated',
      stdoutPath: out,
      stdoutBytes: 7,
    });
    expect(typeof payload.stderrBytes).toBe('number');
  });
});
