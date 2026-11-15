import { readFileSync } from 'node:fs';
import type { ControlStallProbe, ControlStallProbeResult } from './control-stall-detector';
import { parseTmuxServerPid } from './socket-recovery';

export type ProcStatReader = (pid: number) => string | null;

export function readProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
}

/** `/proc/<pid>/stat` 第三字段；comm 可能含空格与括号，按最后一个 `)` 切。 */
export function parseProcState(stat: string | null): string | null {
  if (!stat) return null;
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  return (
    stat
      .slice(end + 1)
      .trim()
      .charAt(0) || null
  );
}

const DEAD_PROC_STATES = new Set(['T', 't', 'Z', 'X', 'x']);

/** 进程不在或已停止/僵尸视为死；R/S/D/I 等只是慢。 */
export function classifyProcState(state: string | null): 'alive' | 'dead' {
  return state === null || DEAD_PROC_STATES.has(state) ? 'dead' : 'alive';
}

/**
 * 本机 tmux server 存活探针：控制通道第一次超时时通过一次性命令学 `#{pid}`，
 * 卡死判定前读 /proc 区分「慢」与「停/死」。非 Linux 或 pid 未知时返回 unknown（不宽限）。
 */
export class LocalTmuxServerLiveness implements ControlStallProbe {
  private pid: number | null = null;
  private learning = false;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly queryPid: () => Promise<string | null>,
    private readonly readStat: ProcStatReader = readProcStat
  ) {}

  get serverPid(): number | null {
    return this.pid;
  }

  prepare(): void {
    if (this.platform !== 'linux' || this.pid !== null || this.learning) return;
    this.learning = true;
    void this.queryPid()
      .then((stdout) => {
        this.pid = parseTmuxServerPid(stdout);
      })
      .catch(() => undefined)
      .finally(() => {
        this.learning = false;
      });
  }

  check(): ControlStallProbeResult {
    if (this.platform !== 'linux' || this.pid === null) return 'unknown';
    const result = classifyProcState(parseProcState(this.readStat(this.pid)));
    if (result === 'dead') this.pid = null;
    return result;
  }
}
