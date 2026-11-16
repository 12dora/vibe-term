import { totalmem } from 'node:os';
import { logAt } from './log/level';

export type MemoryProfile = 'standard' | 'small';

/** 主机物理内存 ≤ 此值且未显式设置时自动 `small`。 */
export const SMALL_HOST_TOTAL_MEM_BYTES = 2 * 1024 * 1024 * 1024;

let logged = false;

export function resolveMemoryProfile(
  env: NodeJS.ProcessEnv = process.env,
  totalMemBytes: number = totalmem(),
  constrainedMemBytes: number = process.constrainedMemory() || Number.POSITIVE_INFINITY
): MemoryProfile {
  const raw = env.VIBETERM_MEMORY_PROFILE?.trim().toLowerCase();
  if (raw === 'small' || raw === 'standard') return raw;
  if (raw) {
    throw new Error('VIBETERM_MEMORY_PROFILE must be standard | small');
  }
  const available = Math.min(totalMemBytes, constrainedMemBytes);
  return available <= SMALL_HOST_TOTAL_MEM_BYTES ? 'small' : 'standard';
}

export function getMemoryProfile(): MemoryProfile {
  return resolveMemoryProfile();
}

export function isSmallMemoryProfile(): boolean {
  return getMemoryProfile() === 'small';
}

export function logMemoryProfileOnce(profile: MemoryProfile = getMemoryProfile()): void {
  if (logged) return;
  logged = true;
  logAt('info', `[memory] profile=${profile}`);
}

export const SETTLED_GC_DELAY_MS = 30_000;

/** 启动完成后做一次完整 GC，回收启动期临时分配；只跑一次，unref 不阻止退出。 */
export function scheduleSettledGc(
  deps: {
    delayMs?: number;
    gc?: () => void;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
  } = {}
): void {
  const gc = deps.gc ?? (() => Bun.gc(true));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const timer = setTimer(gc, deps.delayMs ?? SETTLED_GC_DELAY_MS);
  timer.unref?.();
}
