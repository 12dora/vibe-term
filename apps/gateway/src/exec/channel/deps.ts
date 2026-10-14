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

export const realClock: ExecClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
