// `vibeterm sessions [--memory]`：列出节点上的 tmux 窗口，可选内存列。

import { type SessionsMemoryResponse, formatBytes } from '@vibeterm/shared';
import { flagBool, parseArgv } from '../core/args';
import { rejectExtra } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  type SessionsDeviceRow,
  type SessionsWindowRow,
  fillDisconnectedDevices,
} from '../core/sessions-memory';
import type { Command } from './types';

const FLAGS = {
  memory: 'boolean',
} as const;

const USAGE = [
  'Usage: vibeterm sessions [--node <node>] [--memory] [--json]',
  '',
  'List tmux windows on the target node (GET /api/sessions/memory).',
  '',
  '  --memory    add SCOPE, SOURCE, MEM, HIGH, MAX, OOM columns',
  '  --json      print the (possibly WS-filled) payload as JSON',
  '',
  'Human table: DEVICE, WINDOW (`@id name`), PANES.',
  'With --memory: SCOPE (first scope, `+N` when more, `-` when none), SOURCE (`cgroup`',
  'or `RSS`), MEM (current), HIGH, MAX (`∞` when 0), OOM (kills, `!` when oomFlag).',
  'SOURCE, MEM, HIGH, MAX, and OOM print `-` when the window is unsampled.',
  'Devices with limitsSupported:false print `(limits unavailable)` after their rows.',
  'Devices with supported:false print `(cannot sample memory)` after their rows',
  '(not in addition to the limits note).',
  'Devices with connected:false are listed via a short device session; --memory waits',
  'for window-memory samples (2×sampleIntervalSec+3s, at most 4 sessions at once).',
  'Non-TTY stdout defaults to JSON (like exec).',
].join('\n');

const LIMITS_UNAVAILABLE_NOTE = '(limits unavailable)';
const CANNOT_SAMPLE_NOTE = '(cannot sample memory)';

interface SessionRow {
  deviceName: string;
  window: string;
  panes: string;
  scope: string;
  source: string;
  mem: string;
  high: string;
  max: string;
  oom: string;
  note: string | null;
}

function wantJson(ctx: CliContext): boolean {
  return ctx.globals.json || !ctx.out.isStdoutTty();
}

function formatScope(scopes: readonly string[] | undefined): string {
  if (!scopes || scopes.length === 0) return '-';
  const extra = scopes.length - 1;
  return extra > 0 ? `${scopes[0]}+${extra}` : scopes[0];
}

function formatLimit(bytes: number): string {
  return bytes === 0 ? '∞' : formatBytes(bytes);
}

function formatOom(kills: number, flag: boolean): string {
  return `${kills}${flag ? '!' : ''}`;
}

function formatSource(window: SessionsWindowRow): string {
  if (!window.sampledAt) return '-';
  return window.source === 'rss' ? 'RSS' : 'cgroup';
}

function deviceNote(device: SessionsDeviceRow, memory: boolean): string | null {
  if (!memory) return null;
  if (device.limitsSupported === false) return LIMITS_UNAVAILABLE_NOTE;
  if (!device.supported) return CANNOT_SAMPLE_NOTE;
  return null;
}

function windowLabel(window: SessionsWindowRow): string {
  return `${window.windowId} ${window.windowName}`.trimEnd();
}

function placeholderRow(device: SessionsDeviceRow, note: string | null): SessionRow {
  return {
    deviceName: device.deviceName || device.deviceId,
    window: '-',
    panes: '0',
    scope: '-',
    source: '-',
    mem: '-',
    high: '-',
    max: '-',
    oom: '-',
    note,
  };
}

function windowRow(
  device: SessionsDeviceRow,
  window: SessionsWindowRow,
  note: string | null
): SessionRow {
  const sampled = Boolean(window.sampledAt);
  return {
    deviceName: device.deviceName || device.deviceId,
    window: windowLabel(window),
    panes: String(window.panes),
    scope: formatScope(window.scopes),
    source: formatSource(window),
    mem: sampled ? formatBytes(window.current) : '-',
    high: sampled ? formatLimit(window.high) : '-',
    max: sampled ? formatLimit(window.max) : '-',
    oom: sampled ? formatOom(window.oomKills, window.oomFlag) : '-',
    note,
  };
}

function buildRows(devices: readonly SessionsDeviceRow[], memory: boolean): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const device of devices) {
    const windows = device.windows ?? [];
    const note = deviceNote(device, memory);
    if (windows.length === 0) {
      if (note) rows.push(placeholderRow(device, note));
      continue;
    }
    for (let index = 0; index < windows.length; index += 1) {
      const last = index === windows.length - 1;
      rows.push(windowRow(device, windows[index], last ? note : null));
    }
  }
  return rows;
}

function printTable(ctx: CliContext, rows: SessionRow[], memory: boolean): void {
  const columns = [
    { header: 'DEVICE', value: (row: SessionRow) => row.deviceName },
    { header: 'WINDOW', value: (row: SessionRow) => row.window },
    { header: 'PANES', value: (row: SessionRow) => row.panes },
    ...(memory
      ? [
          { header: 'SCOPE', value: (row: SessionRow) => row.scope },
          { header: 'SOURCE', value: (row: SessionRow) => row.source },
          { header: 'MEM', value: (row: SessionRow) => row.mem },
          { header: 'HIGH', value: (row: SessionRow) => row.high },
          { header: 'MAX', value: (row: SessionRow) => row.max },
          { header: 'OOM', value: (row: SessionRow) => row.oom },
        ]
      : []),
  ];
  if (rows.length === 0) {
    ctx.out.info('(empty)');
    return;
  }
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index].length))
  );
  ctx.out.line(
    ctx.out.style(
      columns
        .map((column, index) => column.header.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
      'bold'
    )
  );
  for (let index = 0; index < rows.length; index += 1) {
    ctx.out.line(
      cells[index]
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd()
    );
    if (rows[index].note) ctx.out.line(rows[index].note as string);
  }
}

function devicesOf(payload: unknown): SessionsDeviceRow[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const devices = (payload as SessionsMemoryResponse).devices;
  return Array.isArray(devices) ? devices : [];
}

function withDevices(payload: unknown, devices: SessionsDeviceRow[]): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { devices };
  return { ...payload, devices };
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  if (positionals[0]) {
    throw new UsageError(`unexpected argument: ${positionals[0]}`, 'try: vibeterm sessions --help');
  }
  rejectExtra(positionals, 0);
  const memory = flagBool(flags, 'memory');
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json<unknown>(nodeId, 'GET', '/api/sessions/memory');
  const devices = await fillDisconnectedDevices(ctx, devicesOf(payload), memory);
  const next = withDevices(payload, devices);
  if (wantJson(ctx)) {
    ctx.out.line(JSON.stringify(next));
    return;
  }
  printTable(ctx, buildRows(devices, memory), memory);
}

export const command: Command = {
  name: 'sessions',
  summary: 'list tmux windows (optional per-window memory)',
  usage: USAGE,
  flags: FLAGS,
  run,
};
