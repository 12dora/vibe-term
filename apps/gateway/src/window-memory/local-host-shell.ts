import { buildLocalTmuxEnv, getLocalShellPath } from '../tmux/local-shell-path';
import { HOST_SHELL_MAX_OUTPUT_BYTES, HOST_SHELL_TIMEOUT_MS } from './constants';
import type { HostShellResult } from './types';

function killQuiet(proc: { kill: () => void }): void {
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = limit - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = limit;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function runLocalHostShell(
  script: string,
  opts?: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<HostShellResult> {
  const timeoutMs = opts?.timeoutMs ?? HOST_SHELL_TIMEOUT_MS;
  const maxOutputBytes = opts?.maxOutputBytes ?? HOST_SHELL_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const subprocess = Bun.spawn(['sh', '-c', script], {
      env: buildLocalTmuxEnv(getLocalShellPath()),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killQuiet(subprocess);
    }, timeoutMs);
    Promise.all([
      readBounded(subprocess.stdout, maxOutputBytes),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: timedOut
            ? [stderr.trim(), 'host shell timed out'].filter(Boolean).join('\n')
            : stderr,
          exitCode: timedOut ? 124 : exitCode,
        });
      })
      .catch((error) => {
        clearTimeout(timer);
        killQuiet(subprocess);
        reject(error);
      });
  });
}
