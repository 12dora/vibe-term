import { afterEach, describe, expect, test } from 'bun:test';
import { ExecChannelError } from './errors';
import { spawnExecProcess } from './process';
import {
  collect,
  collectAll,
  openSpec,
  readUntil,
  testDevice,
  waitGone,
} from './process-test-util';

const device = testDevice();
const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

async function spawnArgv(argv: string[], extra: Parameters<typeof openSpec>[0] = {}) {
  return spawnExecProcess(device, openSpec({ command: { kind: 'argv', argv }, ...extra }));
}

describe('local pipe process', () => {
  test('captures stdout and a zero exit', async () => {
    const proc = await spawnArgv(['printf', 'hello']);
    expect(proc.pty).toBe(false);
    expect(proc.pid).toBeGreaterThan(0);
    const result = await collectAll(proc);
    expect(result).toEqual({ stdout: 'hello', stderr: '', exit: { code: 0, signal: null } });
  });

  test('keeps stdout and stderr apart and passes the exit code through', async () => {
    const proc = await spawnExecProcess(
      device,
      openSpec({ command: { kind: 'shell', script: 'echo out; echo err 1>&2; exit 7', sh: true } })
    );
    const result = await collectAll(proc);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exit).toEqual({ code: 7, signal: null });
  });

  test('round-trips binary stdin through cat and closes on endStdin', async () => {
    const proc = await spawnArgv(['cat'], { stdin: true });
    const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
    const out = collect(() => proc.readStdout());
    await proc.writeStdin(payload);
    await proc.endStdin();
    expect(Buffer.from(await out)).toEqual(Buffer.from(payload));
    expect((await proc.exited).code).toBe(0);
  });

  test('stdin false behaves like /dev/null', async () => {
    const proc = await spawnArgv(['cat']);
    const result = await collectAll(proc);
    expect(result.stdout).toBe('');
    expect(result.exit.code).toBe(0);
    await proc.writeStdin(new Uint8Array([1]));
    await proc.endStdin();
  });

  test('writes after the child exited are dropped without errors', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);
    try {
      const proc = await spawnArgv(['sleep', '30'], { stdin: true });
      const big = new Uint8Array(2 * 1024 * 1024).fill(0x61);
      const pending = proc.writeStdin(big);
      await Bun.sleep(50);
      proc.kill();
      await pending;
      expect((await proc.exited).signal).toBe('SIGTERM');
      await proc.writeStdin(big);
      await proc.endStdin();
      await Bun.sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test('kill terminates the whole process group', async () => {
    const proc = await spawnExecProcess(
      device,
      openSpec({
        command: { kind: 'shell', script: 'sleep 30 & echo $!; wait', sh: true },
      })
    );
    const out = await readUntil(proc, '\n');
    const grandchild = Number(out.trim());
    expect(grandchild).toBeGreaterThan(0);
    proc.kill();
    const exit = await proc.exited;
    expect(exit.signal).toBe('SIGTERM');
    expect(await waitGone(grandchild)).toBe(true);
  });

  test('signal reaches the child and reports its handled exit code', async () => {
    const proc = await spawnExecProcess(
      device,
      openSpec({
        command: {
          kind: 'shell',
          script: "trap 'exit 5' INT; echo ready; while :; do sleep 0.05; done",
          sh: true,
        },
      })
    );
    await readUntil(proc, 'ready');
    proc.signal('SIGINT');
    expect(await proc.exited).toEqual({ code: 5, signal: null });
  });

  test('signal on a finished process is swallowed', async () => {
    const proc = await spawnArgv(['true']);
    await proc.exited;
    expect(() => proc.signal('SIGTERM')).not.toThrow();
    expect(() => proc.kill()).not.toThrow();
  });

  test('uses the scrubbed environment with spec.env overlaid', async () => {
    process.env.VIBETERM_MASTER_KEY = 'secret';
    process.env.TMEX_OLD = 'x';
    process.env.DATABASE_URL = './db';
    process.env.NODE_ENV = 'production';
    const proc = await spawnExecProcess(
      device,
      openSpec({
        command: { kind: 'argv', argv: ['/usr/bin/env'] },
        env: { MY_VAR: 'v1' },
      })
    );
    const { stdout } = await collectAll(proc);
    const lines = stdout.split('\n');
    expect(lines).toContain('MY_VAR=v1');
    expect(lines.some((l) => l.startsWith('HOME='))).toBe(true);
    expect(lines.some((l) => l.startsWith('SHELL='))).toBe(true);
    for (const banned of ['VIBETERM_MASTER_KEY=', 'TMEX_OLD=', 'DATABASE_URL=', 'NODE_ENV=']) {
      expect(lines.some((l) => l.startsWith(banned))).toBe(false);
    }
  });

  test('defaults cwd to the home directory and honours spec.cwd', async () => {
    const home = await collectAll(await spawnArgv(['pwd', '-P']));
    expect(home.stdout.trim().length).toBeGreaterThan(0);
    const tmp = await collectAll(await spawnArgv(['pwd'], { cwd: '/usr' }));
    expect(tmp.stdout.trim()).toBe('/usr');
  });

  test('the shell kind runs under /bin/sh when sh is set', async () => {
    const proc = await spawnExecProcess(
      device,
      openSpec({ command: { kind: 'shell', script: 'echo $0', sh: true } })
    );
    expect((await collectAll(proc)).stdout.trim()).toBe('/bin/sh');
  });
});

describe('local spawn failures', () => {
  test('missing executable', async () => {
    const err = await spawnArgv(['/nonexistent/binary-xyz']).catch((e) => e);
    expect(err).toBeInstanceOf(ExecChannelError);
    expect(err.code).toBe('exec_spawn_failed');
  });

  test('missing cwd', async () => {
    const err = await spawnArgv(['true'], { cwd: '/nonexistent/dir-xyz' }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecChannelError);
    expect(err.code).toBe('exec_spawn_failed');
    expect(err.message).toContain('/nonexistent/dir-xyz');
  });

  test('invalid env names are rejected before spawning', async () => {
    const err = await spawnArgv(['true'], { env: { 'BAD-KEY': '1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecChannelError);
    expect(err.code).toBe('invalid_request');
  });

  test('non local or ssh devices are unsupported', async () => {
    const odd = { ...device, type: 'weird' } as unknown as typeof device;
    const err = await spawnExecProcess(odd, openSpec()).catch((e) => e);
    expect(err.code).toBe('exec_unsupported_device');
  });
});
