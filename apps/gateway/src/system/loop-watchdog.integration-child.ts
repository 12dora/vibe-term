import { startLoopWatchdogFromEnv } from './loop-watchdog';

export const LOOP_WATCHDOG_CHILD_VERSION = 'wp1-child';

const mode = process.argv[2] ?? 'stall';
const watchdog = startLoopWatchdogFromEnv(LOOP_WATCHDOG_CHILD_VERSION);

if (mode === 'stall') {
  watchdog.markStarted();
  await Bun.sleep(300);
  Bun.sleepSync(30_000);
  process.exit(0);
}

if (mode === 'boot') {
  Bun.sleepSync(6_000);
  process.exit(0);
}

if (mode === 'stop') {
  watchdog.markStarted();
  watchdog.stop();
  Bun.sleepSync(8_000);
  process.exit(0);
}

if (mode === 'suspend') {
  watchdog.markStarted();
  const t0 = Date.now();
  setInterval(() => {
    console.log(`[child] alive ${Math.floor((Date.now() - t0) / 1000)}s`);
  }, 1000);
  await Bun.sleep(25_000);
  process.exit(0);
}

console.error(`unknown loop-watchdog child mode: ${mode}`);
process.exit(2);
