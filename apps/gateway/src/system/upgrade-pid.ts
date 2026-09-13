import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePidFileRecord as parseSharedPidFileRecord } from '../../../../packages/shared/src/process/pid-file';

export type PidFileRecord = { pid: number; identity?: string | null };
export type ProcessStartIdentityFn = (pid: number) => string | null;

function parsePidFileRecord(raw: string): PidFileRecord | null {
  const record = parseSharedPidFileRecord(raw, { allowNumericStringPid: true });
  return record ? { pid: record.pid, identity: record.identity ?? null } : null;
}

export function readNoneModePidRecord(installDir: string): PidFileRecord | null {
  // 改名前安装的实例写的是 tmex.pid；服务重新注册前 run.sh 仍在写旧名。
  for (const name of ['vibeterm.pid', 'tmex.pid']) {
    try {
      return parsePidFileRecord(readFileSync(join(installDir, name), 'utf8'));
    } catch {
      // 换下一个名字
    }
  }
  return null;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function identityMatches(
  pid: number,
  expected: string,
  readIdentity: ProcessStartIdentityFn
): boolean | null {
  try {
    const live = readIdentity(pid);
    if (live === null) return null;
    return live === expected;
  } catch {
    return null;
  }
}
