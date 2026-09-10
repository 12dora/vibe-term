// cp 进度：TTY 上 stderr 覆盖一行；`--json` 时 stdout 写 NDJSON 事件。

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
}

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
  constructor(
    private readonly out: Output,
    private readonly json: boolean
  ) {}

  emit(event: CopyProgressEvent): void {
    if (this.json) {
      this.out.line(JSON.stringify(event));
      return;
    }
    if (event.type === 'progress') {
      const pct = event.pct ?? 0;
      const bytes = event.bytes ?? 0;
      const total = event.total ?? 0;
      const rate = event.rate ? `  ${event.rate}` : '';
      const path = event.path ? `  ${event.path}` : '';
      const pair = total > 0 ? `${formatBytes(bytes)} / ${formatBytes(total)}` : formatBytes(bytes);
      this.out.progress(`${event.phase ?? 'copy'}  ${pct}%  ${pair}${rate}${path}`);
      return;
    }
    if (event.type === 'item' && event.path) this.out.info(event.path);
    if (event.type === 'error' && event.message) this.out.warn(event.message);
  }

  finish(): void {
    if (!this.json) this.out.endProgress();
  }
}

export function pctOf(bytes: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((bytes / total) * 100)));
}
