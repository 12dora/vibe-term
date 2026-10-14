import type { Device } from '@vibeterm/shared';
import type { ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import type { ExecProcess } from './process-types';

export function testDevice(type: Device['type'] = 'local'): Device {
  const now = new Date().toISOString();
  return {
    id: `proc-${type}`,
    name: `proc-${type}`,
    type,
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function openSpec(overrides: Partial<ExecOpenSpec> = {}): ExecOpenSpec {
  return {
    command: { kind: 'argv', argv: ['/bin/true'] },
    stdin: false,
    ...overrides,
  };
}

export async function collect(read: () => Promise<Uint8Array | null>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (;;) {
    const chunk = await read();
    if (chunk === null) break;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export async function collectAll(proc: ExecProcess): Promise<{
  stdout: string;
  stderr: string;
  exit: Awaited<ExecProcess['exited']>;
}> {
  const [stdout, stderr, exit] = await Promise.all([
    collect(() => proc.readStdout()),
    collect(() => proc.readStderr()),
    proc.exited,
  ]);
  return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exit };
}

export async function readUntil(
  proc: ExecProcess,
  needle: string,
  timeoutMs = 5000
): Promise<string> {
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (!acc.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}; got ${acc}`);
    const chunk = await Promise.race([
      proc.readStdout(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
    ]);
    if (chunk === 'timeout') throw new Error(`timeout waiting for ${needle}; got ${acc}`);
    if (chunk === null) break;
    acc += Buffer.from(chunk).toString('utf8');
  }
  return acc;
}

export async function waitGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}
