import { join } from 'node:path';
import { parseBoolEnv } from '../../../../packages/shared/src/env/parse';
import { envInt } from '../mesh/mesh-log';

export type LoopWatchdogSignal = 'SIGABRT' | 'SIGKILL';

export type LoopWatchdogOptions = {
  stallSec: number;
  bootSec: number;
  signal: LoopWatchdogSignal;
  installDir?: string;
};

type HeartbeatCells = Int32Array<ArrayBufferLike>;

export type LoopWatchdogHandle = {
  markStarted: () => void;
  stop: () => void;
  cells: HeartbeatCells;
};

const DEFAULT_STALL_SEC = 30;
const DEFAULT_BOOT_SEC = 180;
const MIN_STALL_SEC = 5;
const MIN_BOOT_SEC = 10;
const HEARTBEAT_MS = 1_000;
const HEARTBEAT_INITIAL = 1;
const READY_TIMEOUT_MS = 5_000;
const CELL_COUNT = 3;
const CELL_HEARTBEAT = 0;
const CELL_STARTED = 1;
const CELL_WAIT = 2;

export type StallTickState = {
  seen: number;
  staleTicks: number;
};

export function nextStallState(
  cur: number,
  threshold: number,
  state: StallTickState
): StallTickState & { kill: boolean } {
  if (cur !== state.seen) {
    return { seen: cur, staleTicks: 0, kill: false };
  }
  const staleTicks = state.staleTicks + 1;
  return { seen: state.seen, staleTicks, kill: staleTicks >= threshold };
}

export const LOOP_WATCHDOG_WORKER_SOURCE = `"use strict";
var nextStallState = ${nextStallState.toString()};
onmessage = function (ev) {
  var msg = ev.data;
  var cells = msg.cells;
  var stallSec = msg.stallSec;
  var bootSec = msg.bootSec;
  var signal = msg.signal;
  var pid = msg.pid;
  var version = msg.version;
  var installDir = msg.installDir;
  var logPath = msg.logPath;
  postMessage('ready');
  var seen = Atomics.load(cells, 0);
  var staleTicks = 0;
  for (;;) {
    Atomics.wait(cells, 2, 0, 1000);
    if (Atomics.load(cells, 2) !== 0) return;
    var cur = Atomics.load(cells, 0);
    var started = Atomics.load(cells, 1) === 1;
    var threshold = started ? stallSec : bootSec;
    var tick = nextStallState(cur, threshold, {
      seen: seen,
      staleTicks: staleTicks,
    });
    seen = tick.seen;
    staleTicks = tick.staleTicks;
    if (!tick.kill) continue;
    var phase = started ? 'running' : 'boot';
    var stalledSec = staleTicks;
    console.error(
      '[vibeterm][loop-watchdog] main thread stalled for ' +
        stalledSec +
        's (threshold ' +
        threshold +
        's, phase ' +
        phase +
        '); sending ' +
        signal
    );
    if (installDir) {
      try {
        var rss = 0;
        var uptime = 0;
        try {
          rss = process.memoryUsage().rss;
          uptime = Math.floor(process.uptime());
        } catch (e) {}
        require('node:fs').appendFileSync(
          logPath || installDir + '/loop-watchdog.log',
          JSON.stringify({
            ts: new Date().toISOString(),
            pid: pid,
            version: version,
            phase: phase,
            stalledSec: stalledSec,
            thresholdSec: threshold,
            signal: signal,
            rssBytes: rss,
            uptimeSec: uptime,
            staleTicks: staleTicks,
          }) + '\\n'
        );
      } catch (e) {}
    }
    process.kill(process.pid, signal);
    return;
  }
};
`;

function defaultSignal(_platform: string): LoopWatchdogSignal {
  return 'SIGKILL';
}

function resolveSignal(raw: string | undefined, platform: string): LoopWatchdogSignal {
  if (raw === 'SIGABRT' || raw === 'SIGKILL') return raw;
  return defaultSignal(platform);
}

function envIntFrom(env: NodeJS.Dict<string>, name: string, fallback: number, min: number): number {
  if (env === process.env) return envInt(name, fallback, min);
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

function noopHandle(cells: HeartbeatCells = new Int32Array(CELL_COUNT)): LoopWatchdogHandle {
  return {
    cells,
    markStarted() {},
    stop() {},
  };
}

export function resolveLoopWatchdogOptions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): LoopWatchdogOptions | null {
  const defaultOn = env.NODE_ENV === 'production';
  if (!parseBoolEnv(env.VIBETERM_LOOP_WATCHDOG, defaultOn)) return null;
  const installDir = env.VIBETERM_INSTALL_DIR?.trim();
  return {
    stallSec: envIntFrom(env, 'VIBETERM_LOOP_WATCHDOG_STALL_SEC', DEFAULT_STALL_SEC, MIN_STALL_SEC),
    bootSec: envIntFrom(env, 'VIBETERM_LOOP_WATCHDOG_BOOT_SEC', DEFAULT_BOOT_SEC, MIN_BOOT_SEC),
    signal: resolveSignal(env.VIBETERM_LOOP_WATCHDOG_SIGNAL, platform),
    installDir: installDir || undefined,
  };
}

type WatchdogRuntime = {
  stopped: boolean;
  armed: boolean;
  heartbeat: ReturnType<typeof setInterval>;
  worker: Worker | null;
  blobUrl: string | null;
  cells: HeartbeatCells;
  readyTimer: ReturnType<typeof setTimeout> | null;
};

function stopRuntime(runtime: WatchdogRuntime): void {
  if (runtime.stopped) return;
  runtime.stopped = true;
  if (runtime.readyTimer) {
    clearTimeout(runtime.readyTimer);
    runtime.readyTimer = null;
  }
  clearInterval(runtime.heartbeat);
  Atomics.store(runtime.cells, CELL_WAIT, 1);
  Atomics.notify(runtime.cells, CELL_WAIT);
  runtime.worker?.terminate();
  if (runtime.blobUrl) URL.revokeObjectURL(runtime.blobUrl);
}

function spawnWatchdogWorker(): { worker: Worker; blobUrl: string } {
  const blobUrl = URL.createObjectURL(
    new Blob([LOOP_WATCHDOG_WORKER_SOURCE], { type: 'application/javascript' })
  );
  try {
    const worker = new Worker(blobUrl);
    (worker as unknown as { unref?: () => void }).unref?.();
    return { worker, blobUrl };
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

function workerErrorText(e: { message?: string } | Event): string {
  return 'message' in e && e.message != null && e.message !== '' ? e.message : String(e);
}

function attachWatchdogWorker(
  runtime: WatchdogRuntime,
  cells: HeartbeatCells,
  options: LoopWatchdogOptions & { version: string }
): void {
  const worker = runtime.worker;
  if (!worker) return;
  worker.onerror = (e) => {
    console.error(`[vibeterm][loop-watchdog] worker error: ${workerErrorText(e)}`);
  };
  worker.onmessageerror = (e) => {
    console.error(`[vibeterm][loop-watchdog] worker message error: ${workerErrorText(e)}`);
  };
  worker.onmessage = (e) => {
    if (e.data !== 'ready') return;
    if (runtime.readyTimer) {
      clearTimeout(runtime.readyTimer);
      runtime.readyTimer = null;
    }
    if (runtime.stopped || runtime.armed) return;
    runtime.armed = true;
    console.log(
      `[vibeterm][loop-watchdog] armed stall=${options.stallSec}s boot=${options.bootSec}s signal=${options.signal}`
    );
  };
  runtime.readyTimer = setTimeout(() => {
    runtime.readyTimer = null;
    if (runtime.stopped) return;
    console.error('[vibeterm][loop-watchdog] worker did not report ready within 5s');
  }, READY_TIMEOUT_MS);
  runtime.readyTimer.unref();
  const installDir = options.installDir ?? '';
  worker.postMessage({
    cells,
    stallSec: options.stallSec,
    bootSec: options.bootSec,
    signal: options.signal,
    pid: process.pid,
    version: options.version,
    installDir,
    logPath: installDir ? join(installDir, 'loop-watchdog.log') : '',
  });
}

export function startLoopWatchdog(
  options: LoopWatchdogOptions & { version: string }
): LoopWatchdogHandle {
  const cells: HeartbeatCells = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CELL_COUNT)
  );
  Atomics.store(cells, CELL_HEARTBEAT, HEARTBEAT_INITIAL);
  const heartbeat = setInterval(() => {
    Atomics.add(cells, CELL_HEARTBEAT, 1);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const runtime: WatchdogRuntime = {
    stopped: false,
    armed: false,
    heartbeat,
    worker: null,
    blobUrl: null,
    cells,
    readyTimer: null,
  };
  try {
    const spawned = spawnWatchdogWorker();
    runtime.worker = spawned.worker;
    runtime.blobUrl = spawned.blobUrl;
    attachWatchdogWorker(runtime, cells, options);
  } catch (error) {
    stopRuntime(runtime);
    console.error(`[vibeterm][loop-watchdog] disabled: ${error}`);
    return noopHandle(cells);
  }
  return {
    cells,
    markStarted: () => Atomics.store(cells, CELL_STARTED, 1),
    stop: () => stopRuntime(runtime),
  };
}

export function startLoopWatchdogFromEnv(version: string): LoopWatchdogHandle {
  const options = resolveLoopWatchdogOptions();
  if (!options) return noopHandle();
  return startLoopWatchdog({ ...options, version });
}
