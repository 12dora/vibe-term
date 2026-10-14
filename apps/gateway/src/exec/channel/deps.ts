import type { Device } from '@vibeterm/shared';
import type { ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import type { ExecProcess } from './process';

export interface ExecClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ExecChannelDeps {
  spawn(device: Device, spec: ExecOpenSpec): Promise<ExecProcess>;
  resolveDevice(ref: string | undefined): Device | null;
  clock: ExecClock;
  maxSessions: number;
}

/** 单次 setTimeout 的上限（2^31-1 ms）；更长的延迟在 Bun/Node 中会被当作 1 ms 立即触发。 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type LongTimer = { current: unknown };

export function createClock(timers: TimerApi, now: () => number): ExecClock {
  return {
    now,
    setTimeout(fn, ms) {
      const timer: LongTimer = { current: null };
      const arm = (left: number): void => {
        const step = Math.min(left, MAX_TIMER_MS);
        timer.current = timers.setTimeout(() => (left > step ? arm(left - step) : fn()), step);
      };
      arm(Number.isFinite(ms) && ms > 0 ? ms : 0);
      return timer;
    },
    clearTimeout(handle) {
      timers.clearTimeout((handle as LongTimer).current);
    },
  };
}

export const realClock: ExecClock = createClock(
  {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  () => Date.now()
);
