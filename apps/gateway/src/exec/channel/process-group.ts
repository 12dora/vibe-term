import type { ExecSignal } from '@vibeterm/shared/exec-channel';
import { EXEC_KILL_GRACE_MS } from '../constants';
import type { ExecProcessExit } from './process-types';

export function signalGroup(pid: number | null, sig: ExecSignal): void {
  if (pid === null) return;
  try {
    process.kill(-pid, sig);
    return;
  } catch (err) {
    if (isNoSuchProcess(err)) return;
  }
  try {
    process.kill(pid, sig);
  } catch {
    // 进程已退出
  }
}

function isNoSuchProcess(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH';
}

export class GroupControl {
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly pid: number | null,
    private readonly hasExited: () => boolean
  ) {}

  signal(sig: ExecSignal): void {
    signalGroup(this.pid, sig);
  }

  kill(): void {
    signalGroup(this.pid, 'SIGTERM');
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      signalGroup(this.pid, 'SIGKILL');
    }, EXEC_KILL_GRACE_MS);
    this.killTimer.unref();
  }

  /** 进程已被回收且从未请求 kill 时无需保留 SIGKILL 定时器；请求过 kill 则让其继续收割残余成员。 */
  settle(): void {
    if (this.killTimer && this.hasExited() && !this.groupAlive()) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try {
      process.kill(-this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export type ProcessExitSource = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | number | null;
};

export function toProcessExit(proc: ProcessExitSource, rawCode: number): ExecProcessExit {
  if (typeof proc.signalCode === 'string') return { code: null, signal: proc.signalCode };
  return { code: proc.exitCode ?? rawCode, signal: null };
}
