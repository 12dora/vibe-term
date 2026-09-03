import {
  constants,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { processStartIdentity } from '../../../shared/src/process/process-identity';
import { t } from '../i18n';
import { ensureDir } from './fs-utils';

export { processStartIdentity };

export interface UpgradeLock {
  installDir: string;
  path: string;
}

export interface LockPayload {
  pid: number;
  startedAt: string;
  identity: string | null;
}

export function lockPath(installDir: string): string {
  return join(installDir, 'upgrade.lock');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isLockStale(payload: LockPayload | null): boolean {
  if (!payload || !Number.isInteger(payload.pid) || payload.pid <= 0) return true;
  if (!isPidAlive(payload.pid)) return true;
  if (!payload.identity) return false;
  const live = processStartIdentity(payload.pid);
  if (live === null) return false;
  return live !== payload.identity;
}

function readLockPayload(path: string): LockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockPayload>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      identity: typeof parsed.identity === 'string' ? parsed.identity : null,
    };
  } catch {
    return null;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function acquireUpgradeLock(installDir: string): Promise<UpgradeLock> {
  await ensureDir(installDir);
  const path = lockPath(installDir);
  const payload = `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    identity: processStartIdentity(process.pid),
  })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return { installDir, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = existsSync(path) ? readLockPayload(path) : null;
      if (holder && !isLockStale(holder)) {
        throw new Error(t('upgrade.lockHeld', { pid: holder.pid, path }));
      }
      unlinkIfExists(path);
    }
  }

  throw new Error(t('upgrade.lockHeld', { pid: 'unknown', path }));
}

export async function releaseUpgradeLock(lock: UpgradeLock): Promise<void> {
  unlinkIfExists(lock.path);
}
