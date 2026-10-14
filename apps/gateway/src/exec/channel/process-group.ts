import { readFileSync, readdirSync } from 'node:fs';
import type { ExecSignal } from '@vibeterm/shared/exec-channel';
import { EXEC_KILL_GRACE_MS } from '../constants';
import type { ExecProcessExit } from './process-types';

export type GroupSignal = ExecSignal | 'SIGSTOP' | 'SIGCONT';

export function signalGroup(pid: number | null, sig: GroupSignal): void {
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

/** PTY 会话里带作业控制的 shell 会把前台作业放进独立进程组，暂停/恢复必须覆盖整个会话。 */
export function signalSession(pid: number | null, sig: GroupSignal): void {
  if (pid === null) return;
  for (const group of sessionGroups(pid)) signalGroup(group, sig);
}

function sessionGroups(sid: number): number[] {
  const groups = new Set<number>([sid]);
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [...groups];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[3]) === sid) groups.add(Number(fields[2]));
    } catch {
      // 进程已退出
    }
  }
  return [...groups];
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

  /** 暂停整个会话；leader 已被回收时不再发信号，避免打到复用的 PID。 */
  stop(): void {
    if (this.hasExited()) return;
    signalSession(this.pid, 'SIGSTOP');
  }

  resume(): void {
    if (this.hasExited() && !this.groupAlive()) return;
    signalSession(this.pid, 'SIGCONT');
  }

  kill(): void {
    if (this.hasExited() && !this.groupAlive()) return;
    signalGroup(this.pid, 'SIGCONT');
    signalGroup(this.pid, 'SIGTERM');
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.hasExited() && !this.groupAlive()) return;
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
    } catch (err) {
      return !isNoSuchProcess(err);
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
