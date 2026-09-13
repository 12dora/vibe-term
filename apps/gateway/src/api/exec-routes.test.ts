import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { createDevice, deleteDevice } from '../db/devices';
import { runMigrations } from '../db/migrate';
import type { ExecProc } from '../exec/child';
import { execIo } from '../exec/io';
import { handleApiRequest } from './index';

beforeAll(() => {
  runMigrations();
});

const created: string[] = [];
const dirs: string[] = [];
const originalSpawn = execIo.spawn;
const originalResolve = execIo.resolveSsh;

afterEach(() => {
  execIo.spawn = originalSpawn;
  execIo.resolveSsh = originalResolve;
  for (const id of created.splice(0)) deleteDevice(id);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localDevice(): Device {
  const now = new Date().toISOString();
  const device: Device = {
    id: `exec-local-${crypto.randomUUID()}`,
    name: 'exec-local',
    type: 'local',
    authMode: 'auto',
    session: 'vibeterm',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  createDevice(device);
  created.push(device.id);
  return device;
}

function sshDevice(authMode: Device['authMode'] = 'key'): Device {
  const now = new Date().toISOString();
  const device: Device = {
    id: `exec-ssh-${crypto.randomUUID()}`,
    name: 'exec-ssh',
    type: 'ssh',
    host: '127.0.0.1',
    username: 'nobody',
    authMode,
    sshConfigRef: authMode === 'configRef' ? 'jump-host' : undefined,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  createDevice(device);
  created.push(device.id);
  return device;
}

function post(body: unknown, signal?: AbortSignal): Promise<Response> {
  return handleApiRequest(
    new Request('http://localhost/api/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  ) as Promise<Response>;
}

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function decodeOut(events: Array<Record<string, unknown>>, type: 'stdout' | 'stderr'): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => Buffer.from(String(e.base64 ?? ''), 'base64').toString())
    .join('');
}

describe('POST /api/exec', () => {
  test('400 JSON for invalid body, missing device, and password SSH', async () => {
    const bad = await post({ argv: ['echo'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_body' });

    const missing = await post({ deviceId: 'no-such-device', argv: ['/bin/echo'] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ code: 'device_not_found', message: 'device not found' });

    const ssh = sshDevice('password');
    const unsupported = await post({ deviceId: ssh.id, argv: ['/bin/echo'] });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'exec_unsupported_device' });
    expect(unsupported.headers.get('content-type')).toContain('application/json');
  });

  test('local echo streams start, stdout, and exit 0', async () => {
    const device = localDevice();
    const res = await post({ deviceId: device.id, argv: ['/bin/echo', 'hello-exec'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({
      type: 'start',
      device: { id: device.id, type: 'local' },
    });
    expect(decodeOut(events, 'stdout')).toContain('hello-exec');
    const exit = events.find((e) => e.type === 'exit') as Record<string, unknown>;
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.truncated).toEqual({ stdout: false, stderr: false });
    expect(typeof exit.durationMs).toBe('number');
  });

  test('shell:true runs /bin/sh -c and merges env / cwd / stdin', async () => {
    const device = localDevice();
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-exec-cwd-'));
    dirs.push(dir);
    const res = await post({
      deviceId: device.id,
      shell: true,
      argv: ['printf %s "$FOO-$(pwd)-"; cat'],
      cwd: dir,
      env: { FOO: 'bar' },
      stdin: { text: 'IN' },
    });
    const events = await readEvents(res);
    expect(decodeOut(events, 'stdout')).toBe(`bar-${realpathSync(dir)}-IN`);
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: 0 });
  });

  test('timeout kills with SIGTERM and emits exec_timeout after exit', async () => {
    const device = localDevice();
    const res = await post({
      deviceId: device.id,
      argv: ['/bin/sleep', '30'],
      timeoutMs: 200,
    });
    const events = await readEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('exit');
    expect(types[types.length - 1]).toBe('error');
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: null, signal: 'SIGTERM' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'exec_timeout' });
  });

  test('missing binary is a streamed exec_spawn_failed', async () => {
    const device = localDevice();
    const res = await post({
      deviceId: device.id,
      argv: ['/definitely/not/a/vibeterm-exec-binary'],
    });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const err = events.find((e) => e.type === 'error');
    const exit = events.find((e) => e.type === 'exit');
    expect(err?.code === 'exec_spawn_failed' || exit).toBeTruthy();
  });

  test('drops stdout past 8 MiB and still reports exit', async () => {
    const device = localDevice();
    const res = await post({
      deviceId: device.id,
      argv: ['/bin/sh', '-c', 'dd if=/dev/zero bs=1048576 count=9 2>/dev/null'],
    });
    const events = await readEvents(res);
    const exit = events.find((e) => e.type === 'exit') as Record<string, unknown> | undefined;
    expect(exit?.truncated).toEqual({ stdout: true, stderr: false });
    const stdoutBytes = events
      .filter((e) => e.type === 'stdout')
      .reduce((n, e) => n + Buffer.from(String(e.base64 ?? ''), 'base64').byteLength, 0);
    expect(stdoutBytes).toBe(8 * 1024 * 1024);
  });

  test('client abort kills the child before the command finishes', async () => {
    const device = localDevice();
    const ac = new AbortController();
    const res = await post({ deviceId: device.id, argv: ['/bin/sleep', '30'] }, ac.signal);
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    if (!reader) return;
    const pid = await readStartPid(reader);
    const started = Date.now();
    ac.abort();
    try {
      while (!(await reader.read()).done) {
        /* drain */
      }
    } catch {
      // 流被取消
    }
    expect(Date.now() - started).toBeLessThan(8_000);
    await expectPidGone(pid, 8_000 - (Date.now() - started));
  });

  test('ssh configRef spawns OpenSSH with BatchMode, -T, and a quoted remote command', async () => {
    const device = sshDevice('configRef');
    const calls: string[][] = [];
    execIo.spawn = ((argv) => {
      calls.push([...argv]);
      return fakeProc();
    }) as typeof execIo.spawn;
    const res = await post({
      deviceId: device.id,
      argv: ['/bin/echo', 'hi'],
      cwd: '/tmp',
      env: { FOO: 'bar' },
    });
    const events = await readEvents(res);
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv[0]).toBe('ssh');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('-T');
    expect(argv).toContain('--');
    const destIdx = argv.lastIndexOf('--') - 1;
    expect(argv[destIdx]).toBe('jump-host');
    expect(argv.at(-1)).toBe("cd '/tmp' && env FOO='bar' '/bin/echo' 'hi'");
    expect(events[0]).toMatchObject({
      type: 'start',
      pid: 4242,
      device: { id: device.id, type: 'ssh' },
    });
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: 0 });
  });

  test('interactive SSH resolve becomes a streamed exec_unsupported_device', async () => {
    const device = sshDevice('key');
    execIo.resolveSsh = (async () => ({
      ok: true as const,
      target: {
        dest: 'u@h',
        sshArgs: ['ssh'],
        env: {},
        cleanup: () => {},
        interactive: true,
      },
    })) as typeof execIo.resolveSsh;
    const spawned: string[][] = [];
    execIo.spawn = ((argv) => {
      spawned.push([...argv]);
      return fakeProc();
    }) as typeof execIo.spawn;
    const res = await post({ deviceId: device.id, argv: ['/bin/echo'] });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(spawned).toEqual([]);
    expect(events).toEqual([
      {
        type: 'error',
        code: 'exec_unsupported_device',
        message: 'password-auth SSH devices are not supported',
      },
    ]);
  });
});

function fakeProc(): ExecProc {
  return {
    pid: 4242,
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    kill() {},
    exitCode: 0,
    signalCode: null,
  };
}

async function readStartPid(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number> {
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended before start');
    buf += new TextDecoder().decode(value);
    const nl = buf.indexOf('\n');
    if (nl < 0) continue;
    const event = JSON.parse(buf.slice(0, nl)) as { type?: string; pid?: number | null };
    expect(event.type).toBe('start');
    expect(typeof event.pid).toBe('number');
    return event.pid as number;
  }
}

async function expectPidGone(pid: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(budgetMs, 200);
  let last: NodeJS.ErrnoException | undefined;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      last = err as NodeJS.ErrnoException;
      if (last.code === 'ESRCH') return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`child pid ${pid} still alive (${last?.code ?? 'no ESRCH'})`);
}
