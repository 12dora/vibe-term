import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LOOP_WATCHDOG_WORKER_SOURCE,
  type LoopWatchdogHandle,
  nextStallState,
  resolveLoopWatchdogOptions,
  startLoopWatchdog,
  startLoopWatchdogFromEnv,
} from './loop-watchdog';

const CHILD = resolve(import.meta.dir, 'loop-watchdog.integration-child.ts');
const CHILD_VERSION = 'wp1-child';
const liveHandles: LoopWatchdogHandle[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const handle of liveHandles.splice(0)) handle.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempInstallDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-loop-watchdog-'));
  tempDirs.push(dir);
  return dir;
}

function track(handle: LoopWatchdogHandle): LoopWatchdogHandle {
  liveHandles.push(handle);
  return handle;
}

function childEnv(installDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.VIBETERM_LOOP_WATCHDOG = '1';
  env.VIBETERM_LOOP_WATCHDOG_STALL_SEC = '5';
  env.VIBETERM_LOOP_WATCHDOG_BOOT_SEC = '10';
  env.VIBETERM_LOOP_WATCHDOG_SIGNAL = 'SIGKILL';
  env.VIBETERM_INSTALL_DIR = installDir;
  return env;
}

type SpawnedChild = {
  pid: number;
  proc: ReturnType<typeof Bun.spawn>;
  stderrNow: () => string;
  wait: (
    timeoutMs: number
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; signalCode: string | null }>;
};

function spawnWatchdogChild(mode: string, installDir: string): SpawnedChild {
  const proc = Bun.spawn([process.execPath, CHILD, mode], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(installDir),
  });
  let stdout = '';
  let stderr = '';
  const decoder = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array>, into: (chunk: string) => void) => {
    for await (const chunk of stream) {
      into(decoder.decode(chunk, { stream: true }));
    }
  };
  const stdoutDone = drain(proc.stdout as ReadableStream<Uint8Array>, (chunk) => {
    stdout += chunk;
  });
  const stderrDone = drain(proc.stderr as ReadableStream<Uint8Array>, (chunk) => {
    stderr += chunk;
  });
  return {
    pid: proc.pid,
    proc,
    stderrNow: () => stderr,
    async wait(timeoutMs: number) {
      const completed = await Promise.race([
        Promise.all([proc.exited, stdoutDone, stderrDone]),
        Bun.sleep(timeoutMs).then(() => null),
      ]);
      if (completed === null) {
        proc.kill('SIGKILL');
        await proc.exited;
        throw new Error(`loop-watchdog child mode=${mode} did not exit within ${timeoutMs}ms`);
      }
      return { exitCode: completed[0], stdout, stderr, signalCode: proc.signalCode };
    },
  };
}

async function runChild(
  mode: string,
  installDir: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string; signalCode: string | null }> {
  return spawnWatchdogChild(mode, installDir).wait(timeoutMs);
}

describe('nextStallState', () => {
  test('generation change resets stale ticks', () => {
    expect(nextStallState(2, 5, { seen: 1, staleTicks: 4 })).toEqual({
      seen: 2,
      staleTicks: 0,
      kill: false,
    });
  });

  test('unchanged generation increments stale ticks without killing below threshold', () => {
    expect(nextStallState(1, 5, { seen: 1, staleTicks: 0 })).toEqual({
      seen: 1,
      staleTicks: 1,
      kill: false,
    });
    expect(nextStallState(1, 5, { seen: 1, staleTicks: 2 })).toEqual({
      seen: 1,
      staleTicks: 3,
      kill: false,
    });
  });

  test('kills when staleTicks reaches threshold, including generation 0', () => {
    expect(nextStallState(1, 5, { seen: 1, staleTicks: 4 })).toEqual({
      seen: 1,
      staleTicks: 5,
      kill: true,
    });
    expect(nextStallState(0, 5, { seen: 0, staleTicks: 4 })).toEqual({
      seen: 0,
      staleTicks: 5,
      kill: true,
    });
  });

  test('i32 wrap 2147483647 → -2147483648 counts as a change', () => {
    expect(nextStallState(-2147483648, 5, { seen: 2147483647, staleTicks: 4 })).toEqual({
      seen: -2147483648,
      staleTicks: 0,
      kill: false,
    });
  });

  test('worker source embeds nextStallState via toString', () => {
    expect(LOOP_WATCHDOG_WORKER_SOURCE).toContain('function nextStallState');
    expect(LOOP_WATCHDOG_WORKER_SOURCE).toContain("postMessage('ready')");
  });
});

describe('resolveLoopWatchdogOptions', () => {
  test('production default on; test and development default off', () => {
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'production' }, 'linux')).toEqual({
      stallSec: 30,
      bootSec: 180,
      signal: 'SIGKILL',
    });
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'test' }, 'linux')).toBeNull();
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'development' }, 'linux')).toBeNull();
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'staging' }, 'linux')).toBeNull();
    expect(resolveLoopWatchdogOptions({}, 'linux')).toBeNull();
  });

  test('explicit 1 turns it on anywhere; explicit 0/false turns it off anywhere', () => {
    expect(
      resolveLoopWatchdogOptions({ NODE_ENV: 'test', VIBETERM_LOOP_WATCHDOG: '1' })?.stallSec
    ).toBe(30);
    expect(
      resolveLoopWatchdogOptions({ NODE_ENV: 'development', VIBETERM_LOOP_WATCHDOG: 'true' })
    ).not.toBeNull();
    expect(
      resolveLoopWatchdogOptions({ NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG: '0' })
    ).toBeNull();
    expect(
      resolveLoopWatchdogOptions({ NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG: 'false' })
    ).toBeNull();
  });

  test('ints below min or invalid fall back to defaults; valid ints are kept', () => {
    const base = { NODE_ENV: 'production' };
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_STALL_SEC: '4' })?.stallSec
    ).toBe(30);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_STALL_SEC: '5' })?.stallSec
    ).toBe(5);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_STALL_SEC: 'abc' })?.stallSec
    ).toBe(30);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_STALL_SEC: '' })?.stallSec
    ).toBe(30);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_BOOT_SEC: '9' })?.bootSec
    ).toBe(180);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_BOOT_SEC: '10' })?.bootSec
    ).toBe(10);
    expect(
      resolveLoopWatchdogOptions({ ...base, VIBETERM_LOOP_WATCHDOG_BOOT_SEC: '-1' })?.bootSec
    ).toBe(180);
  });

  test('signal defaults to SIGKILL on every platform; invalid falls back; SIGABRT is opt-in', () => {
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'production' }, 'linux')?.signal).toBe('SIGKILL');
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'production' }, 'darwin')?.signal).toBe(
      'SIGKILL'
    );
    expect(resolveLoopWatchdogOptions({ NODE_ENV: 'production' }, 'win32')?.signal).toBe('SIGKILL');
    expect(
      resolveLoopWatchdogOptions(
        { NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG_SIGNAL: 'SIGTERM' },
        'linux'
      )?.signal
    ).toBe('SIGKILL');
    expect(
      resolveLoopWatchdogOptions(
        { NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG_SIGNAL: 'sigkill' },
        'darwin'
      )?.signal
    ).toBe('SIGKILL');
    expect(
      resolveLoopWatchdogOptions(
        { NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG_SIGNAL: 'SIGABRT' },
        'linux'
      )?.signal
    ).toBe('SIGABRT');
    expect(
      resolveLoopWatchdogOptions(
        { NODE_ENV: 'production', VIBETERM_LOOP_WATCHDOG_SIGNAL: 'SIGKILL' },
        'linux'
      )?.signal
    ).toBe('SIGKILL');
  });

  test('installDir is forwarded when VIBETERM_INSTALL_DIR is set', () => {
    expect(
      resolveLoopWatchdogOptions({
        NODE_ENV: 'production',
        VIBETERM_INSTALL_DIR: '/opt/vibeterm',
      })?.installDir
    ).toBe('/opt/vibeterm');
  });
});

describe('startLoopWatchdog heartbeat', () => {
  test('cells[0] advances after ~1.2s and stop() is idempotent', async () => {
    const handle = track(
      startLoopWatchdog({
        stallSec: 3600,
        bootSec: 3600,
        signal: 'SIGKILL',
        version: 'heartbeat-test',
      })
    );
    const started = Atomics.load(handle.cells, 0);
    expect(started).toBe(1);
    expect(Atomics.load(handle.cells, 1)).toBe(0);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && Atomics.load(handle.cells, 0) === started) {
      await Bun.sleep(100);
    }
    expect(Atomics.load(handle.cells, 0)).toBeGreaterThan(started);
    handle.markStarted();
    expect(Atomics.load(handle.cells, 1)).toBe(1);
    handle.stop();
    handle.stop();
    await Bun.sleep(200);
  });

  test('startLoopWatchdogFromEnv is a silent no-op when disabled', () => {
    const prev = process.env.VIBETERM_LOOP_WATCHDOG;
    delete process.env.VIBETERM_LOOP_WATCHDOG;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const handle = startLoopWatchdogFromEnv('disabled-test');
      handle.markStarted();
      handle.stop();
      expect(logs.some((line) => line.includes('loop-watchdog'))).toBe(false);
    } finally {
      console.log = origLog;
      if (prev === undefined) delete process.env.VIBETERM_LOOP_WATCHDOG;
      else process.env.VIBETERM_LOOP_WATCHDOG = prev;
    }
  });
});

describe('loop-watchdog subprocess', () => {
  test(
    'kills a stalled main thread after markStarted and writes loop-watchdog.log',
    async () => {
      const installDir = tempInstallDir();
      const startedAt = Date.now();
      const result = await runChild('stall', installDir, 15_000);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(15_000);
      expect(result.exitCode === 137 || result.signalCode === 'SIGKILL').toBe(true);
      const combined = `${result.stdout}${result.stderr}`;
      const armedIdx = combined.indexOf('[vibeterm][loop-watchdog] armed');
      const stalledIdx = combined.indexOf('main thread stalled');
      expect(armedIdx).toBeGreaterThanOrEqual(0);
      expect(stalledIdx).toBeGreaterThan(armedIdx);
      expect(result.stderr).toContain('[vibeterm][loop-watchdog] main thread stalled');
      expect(result.stderr).toContain('phase running');
      expect(result.stderr).toContain('sending SIGKILL');
      const logPath = join(installDir, 'loop-watchdog.log');
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const rec = JSON.parse(lines[0]!) as {
        ts: string;
        pid: number;
        version: string;
        phase: string;
        stalledSec: number;
        thresholdSec: number;
        signal: string;
        rssBytes: number;
        uptimeSec: number;
        staleTicks: number;
      };
      expect(rec.phase).toBe('running');
      expect(rec.stalledSec).toBeGreaterThanOrEqual(5);
      expect(rec.stalledSec).toBe(rec.staleTicks);
      expect(rec.thresholdSec).toBe(5);
      expect(rec.staleTicks).toBeGreaterThanOrEqual(5);
      expect(rec.signal).toBe('SIGKILL');
      expect(rec.version).toBe(CHILD_VERSION);
      expect(rec.pid).toBeGreaterThan(0);
      expect(typeof rec.ts).toBe('string');
      expect(rec.rssBytes).toBeGreaterThan(0);
      expect(rec.uptimeSec).toBeGreaterThanOrEqual(0);
    },
    { timeout: 40_000 }
  );

  test(
    'boot grace: block shorter than BOOT_SEC without markStarted exits 0',
    async () => {
      const installDir = tempInstallDir();
      const result = await runChild('boot', installDir, 20_000);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('main thread stalled');
      expect(existsSync(join(installDir, 'loop-watchdog.log'))).toBe(false);
    },
    { timeout: 40_000 }
  );

  test(
    'stop() then block longer than STALL_SEC exits 0',
    async () => {
      const installDir = tempInstallDir();
      const result = await runChild('stop', installDir, 20_000);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('main thread stalled');
      expect(existsSync(join(installDir, 'loop-watchdog.log'))).toBe(false);
    },
    { timeout: 40_000 }
  );

  test.skipIf(process.platform === 'win32')(
    'suspend/resume does not kill a healthy process',
    async () => {
      const installDir = tempInstallDir();
      const spawned = spawnWatchdogChild('suspend', installDir);
      await Bun.sleep(2_000);
      process.kill(spawned.pid, 'SIGSTOP');
      await Bun.sleep(12_000);
      process.kill(spawned.pid, 'SIGCONT');
      await Bun.sleep(5_000);
      expect(spawned.proc.exitCode).toBeNull();
      expect(spawned.stderrNow()).not.toContain('main thread stalled');
      const result = await spawned.wait(40_000);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('main thread stalled');
      expect(existsSync(join(installDir, 'loop-watchdog.log'))).toBe(false);
    },
    { timeout: 60_000 }
  );
});
