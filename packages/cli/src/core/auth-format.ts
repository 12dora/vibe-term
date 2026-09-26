// 登录历史的表格字段，以及保留时间 / 策略时长的人读格式。

import {
  LOGIN_RECORD_PAGE_DEFAULT_LIMIT,
  LOGIN_RECORD_PAGE_MAX_LIMIT,
  LOGIN_RECORD_RETENTION_CHOICES,
  type LoginRecordRetentionDays,
  isLoginRecordRetentionDays,
} from '@vibeterm/shared';
import { UsageError } from './errors';
import type { Column } from './output';

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export interface HistoryView {
  at: number;
  nodeName: string;
  client: string;
  method: string | null;
  second: string | null;
  ip: string | null;
  userAgent: string | null;
  kind: string;
  viaNodeId: string | null;
  code: string | null;
  nodeId: string;
}

export function formatLoginTime(at: number): string {
  return new Date(at)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function describeClient(client: string | null | undefined): string {
  if (client === 'web' || client === 'cli') return client;
  return 'unknown';
}

export function describeMethod(
  method: string | null | undefined,
  second: string | null | undefined
): string {
  if (method === 'passkey') return 'passkey';
  if (method !== 'root') return method || '-';
  if (second === 'totp') return 'password+totp';
  if (second === 'passkey') return 'password+passkey';
  return 'password';
}

function firstMatch(ua: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return null;
}

export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return '-';
  const browser = firstMatch(ua, BROWSERS);
  const os = firstMatch(ua, SYSTEMS);
  if (browser && os) return `${browser} / ${os}`;
  return browser || os || (ua.length > 48 ? `${ua.slice(0, 45)}…` : ua);
}

export function entryLabel(row: HistoryView, names: ReadonlyMap<string, string>): string {
  if (row.kind !== 'background' || !row.viaNodeId) return '-';
  return names.get(row.viaNodeId) ?? row.viaNodeId;
}

export function historyColumns(
  failed: boolean,
  names: ReadonlyMap<string, string>
): Column<HistoryView>[] {
  const columns: Column<HistoryView>[] = [
    { header: 'TIME', value: (row) => formatLoginTime(row.at) },
    { header: 'NODE', value: (row) => row.nodeName },
    { header: 'TYPE', value: (row) => describeClient(row.client) },
    { header: 'METHOD', value: (row) => describeMethod(row.method, row.second) },
    { header: 'IP', value: (row) => row.ip || '-' },
    { header: 'DEVICE', value: (row) => describeDevice(row.userAgent) },
    { header: 'ENTRY', value: (row) => entryLabel(row, names) },
  ];
  if (failed) columns.push({ header: 'CODE', value: (row) => row.code || '-' });
  return columns;
}

export function parseHistoryLimit(value: number | undefined): number {
  if (value === undefined) return LOGIN_RECORD_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > LOGIN_RECORD_PAGE_MAX_LIMIT) {
    throw new UsageError(`--limit must be an integer from 1 to ${LOGIN_RECORD_PAGE_MAX_LIMIT}`);
  }
  return value;
}

const RETENTION_LABEL = LOGIN_RECORD_RETENTION_CHOICES.filter((days) => days !== 0).join(', ');

export function parseRetentionToken(raw: string): LoginRecordRetentionDays {
  const token = raw.trim().toLowerCase();
  if (token === 'forever') return 0;
  const days = Number(token);
  if (!isLoginRecordRetentionDays(days)) {
    throw new UsageError(`retention must be ${RETENTION_LABEL}, or forever, got ${raw}`);
  }
  return days;
}

export function formatRetention(days: number): string {
  return days === 0 ? 'forever' : `${days}d`;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parsePolicyDuration(raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (!match) throw new UsageError(`invalid duration: ${raw}`, 'use 15m, 24h, or 7d');
  const unit = (match[2] ?? 's').toLowerCase();
  return Number(match[1]) * DURATION_UNITS[unit];
}

export function formatDurationMs(ms: number): string {
  if (ms >= 2 * 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0 && ms !== 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms !== 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
