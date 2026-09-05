import { createServer } from 'node:net';
import type { TunnelEdgeResolution } from '@tmex/shared';

export type SpawnSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type SpawnHandle = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
  metricsAddr?: string | null;
  edge?: TunnelEdgeResolution | null;
};

export type Spawner = (spec: SpawnSpec) => SpawnHandle;

export type PickPort = () => Promise<number>;

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    const onError = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => {
        server.removeListener('error', onError);
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function envRecord(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function bunSpawner(spec: SpawnSpec): SpawnHandle {
  const proc = Bun.spawn([spec.command, ...spec.args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: envRecord(spec.env) ?? process.env,
    cwd: spec.cwd,
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited.then((code) => code ?? 1),
    kill(signal?: NodeJS.Signals) {
      try {
        proc.kill(signal ?? 'SIGTERM');
      } catch {}
    },
  };
}

export async function consumeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length > 0) onLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) onLine(buf);
  } catch {
    // 子进程被杀时 reader 可能抛错，忽略即可
  }
}

export async function collectOutput(handle: SpawnHandle): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = '';
  let stderr = '';
  await Promise.all([
    consumeLines(handle.stdout, (line) => {
      stdout += `${line}\n`;
    }),
    consumeLines(handle.stderr, (line) => {
      stderr += `${line}\n`;
    }),
  ]);
  const exitCode = await handle.exited;
  return { stdout, stderr, exitCode };
}
