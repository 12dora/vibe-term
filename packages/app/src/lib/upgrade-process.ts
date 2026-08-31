import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isPidAlive } from './upgrade-lock';

export { isPidAlive };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message?: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleepMs(100);
  }
  throw new Error(message ?? `timed out after ${timeoutMs}ms`);
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  await waitUntil(
    () => !isPidAlive(pid),
    timeoutMs,
    `pid ${pid} did not exit within ${timeoutMs}ms`
  );
}

export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/cmdline`)) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function killPidAndWait(pid: number, timeoutMs: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  try {
    await waitForPidExit(pid, Math.min(timeoutMs, 10_000));
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
    await waitForPidExit(pid, timeoutMs);
  }
}

export function commandLineContains(pid: number, needle: string): boolean {
  const cmd = processCommandLine(pid);
  return Boolean(cmd && needle && cmd.includes(needle));
}
