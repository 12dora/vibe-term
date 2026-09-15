import { buildLocalTmuxEnv, getLocalShellPath } from '../tmux/local-shell-path';
import { HOST_SHELL_MAX_OUTPUT_BYTES, HOST_SHELL_TIMEOUT_MS } from './constants';
import type { HostShellResult } from './types';

const SIGKILL_GRACE_MS = 500;

function killQuiet(
  proc: { kill: (signal?: 'SIGTERM' | 'SIGKILL') => void },
  signal?: 'SIGTERM' | 'SIGKILL'
): void {
  try {
    if (signal) proc.kill(signal);
    else proc.kill();
  } catch {
    /* ignore */
  }
}

function signalQuiet(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* ignore */
  }
}

/** Bun.spawn stays in the parent process group; `process.kill(-pid)` is ESRCH. */
function childPids(pid: number): number[] {
  try {
    const result = Bun.spawnSync(['pgrep', '-P', String(pid)], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => Number.parseInt(line, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  into: { text: string }
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = limit - total;
      if (remaining <= 0) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += slice.byteLength;
      into.text += decoder.decode(slice, { stream: true });
      if (value.byteLength >= remaining) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    into.text += decoder.decode();
  } catch {
    /* detached reader after timeout — ignore */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function escalateKill(proc: ReturnType<typeof Bun.spawn>): ReturnType<typeof setTimeout> {
  const descendants = proc.pid ? childPids(proc.pid) : [];
  killQuiet(proc, 'SIGTERM');
  for (const pid of descendants) signalQuiet(pid, 'SIGTERM');
  return setTimeout(() => {
    killQuiet(proc, 'SIGKILL');
    for (const pid of descendants) signalQuiet(pid, 'SIGKILL');
  }, SIGKILL_GRACE_MS);
}

export async function runLocalHostShell(
  script: string,
  opts?: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<HostShellResult> {
  const timeoutMs = opts?.timeoutMs ?? HOST_SHELL_TIMEOUT_MS;
  const maxOutputBytes = opts?.maxOutputBytes ?? HOST_SHELL_MAX_OUTPUT_BYTES;
  const subprocess = Bun.spawn(['sh', '-c', script], {
    env: buildLocalTmuxEnv(getLocalShellPath()),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutBuf = { text: '' };
  const stderrBuf = { text: '' };
  const completed = Promise.all([
    readBounded(subprocess.stdout, maxOutputBytes, stdoutBuf),
    readBounded(subprocess.stderr, maxOutputBytes, stderrBuf),
    subprocess.exited,
  ]).then(([, , exitCode]) => ({
    stdout: stdoutBuf.text,
    stderr: stderrBuf.text,
    exitCode,
  }));

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HostShellResult>((resolve) => {
    timeoutTimer = setTimeout(() => {
      graceTimer = escalateKill(subprocess);
      resolve({
        exitCode: 124,
        stdout: stdoutBuf.text,
        stderr: 'timeout',
      });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([completed, timedOut]);
    if (result.exitCode !== 124) {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    return result;
  } catch (error) {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    killQuiet(subprocess, 'SIGKILL');
    throw error;
  }
}
