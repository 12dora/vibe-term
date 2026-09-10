// cp 进度：TTY 上 stderr 覆盖一行；`--json` 时 stdout 写 NDJSON 事件。
// 人读进度默认只在 TTY 开；进度事件节流 ≥500 ms 或 ≥1%。

import type { Output } from './output';

export type CopyPhase = 'upload' | 'download' | 'transfer' | 'commit';

export interface CopyProgressEvent {
  type: 'progress' | 'item' | 'done' | 'error';
  phase?: CopyPhase;
  bytes?: number;
  total?: number;
  pct?: number;
  rate?: string;
  path?: string;
  message?: string;
  reason?: string;
  files?: number;
  skipped?: number;
  errors?: number;
  truncated?: boolean;
}

export interface CopyProgressMode {
  json: boolean;
  /** stderr 人读进度（TTY 默认开，`--progress` / `--no-progress` 覆盖）。 */
  human: boolean;
  /** 是否发出 type=progress 事件（json 默认开，可被 `--no-progress` 关掉）。 */
  progress: boolean;
}

const PROGRESS_MIN_MS = 500;
const PROGRESS_MIN_PCT = 1;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export class CopyProgress {
  private lastMs = 0;
  private lastPct = Number.NaN;

  constructor(
    private readonly out: Output,
    private readonly mode: CopyProgressMode
  ) {}

  emit(event: CopyProgressEvent): void {
    if (event.type === 'progress' && !this.allowProgress(event)) return;
    if (this.mode.json) {
      this.out.line(JSON.stringify(event));
      return;
    }
    this.emitHuman(event);
  }

  private emitHuman(event: CopyProgressEvent): void {
    if (event.type === 'progress') {
      if (this.mode.human) this.out.progress(formatHumanProgress(event));
      return;
    }
    if (event.type === 'item' && event.path) this.out.info(event.path);
    if (event.type === 'error' && event.message) this.out.warn(event.message);
  }

  finish(): void {
    if (!this.mode.json) this.out.endProgress();
  }

  private allowProgress(event: CopyProgressEvent): boolean {
    if (!this.mode.progress) return false;
    if (!this.mode.json && !this.mode.human) return false;
    const now = Date.now();
    const pct = event.pct ?? 0;
    const elapsed = now - this.lastMs;
    const jumped = Number.isNaN(this.lastPct) || Math.abs(pct - this.lastPct) >= PROGRESS_MIN_PCT;
    if (this.lastMs !== 0 && elapsed < PROGRESS_MIN_MS && !jumped) return false;
    this.lastMs = now;
    this.lastPct = pct;
    return true;
  }
}

function formatHumanProgress(event: CopyProgressEvent): string {
  const pct = event.pct ?? 0;
  const bytes = event.bytes ?? 0;
  const total = event.total ?? 0;
  const rate = event.rate ? `  ${event.rate}` : '';
  const path = event.path ? `  ${event.path}` : '';
  const pair = total > 0 ? `${formatBytes(bytes)} / ${formatBytes(total)}` : formatBytes(bytes);
  return `${event.phase ?? 'copy'}  ${pct}%  ${pair}${rate}${path}`;
}

export function pctOf(bytes: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((bytes / total) * 100)));
}
