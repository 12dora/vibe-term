import { t } from '../i18n';
import type { HubIo } from './hub';

export type HubListRow = {
  hubNodeId: string;
  name: string | null;
  mode: 'active' | 'standby';
  priority: number;
  writerEpoch: number;
  publicUrl: string;
  online: boolean;
  lastSeenAt: number | null;
  writer: boolean;
  authorized: boolean;
  authorization: 'signed' | 'env' | 'self' | 'no';
};

export function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

export function nowMs(io?: HubIo): number {
  return io?.now?.() ?? Date.now();
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}

function formatLastSeen(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '-';
  try {
    return new Date(value).toISOString();
  } catch {
    return '-';
  }
}

export function formatHubList(rows: HubListRow[]): string[] {
  const lines = [t('hub.list.header')];
  for (const row of rows) {
    const short = row.hubNodeId.slice(0, 8);
    const mark = row.writer ? '*' : ' ';
    lines.push(
      [
        `${mark}${pad(short, 10)}`,
        pad(row.name ?? '-', 15),
        pad(row.mode, 8),
        pad(String(row.priority), 4),
        pad(String(row.writerEpoch), 6),
        pad(row.authorization, 6),
        pad(row.online ? 'yes' : 'no', 7),
        pad(formatLastSeen(row.lastSeenAt), 21),
        row.publicUrl,
      ].join(' ')
    );
  }
  return lines;
}
