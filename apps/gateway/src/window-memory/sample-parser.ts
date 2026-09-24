import type { PaneMemorySource, PaneScopeSample } from './types';

const HEADER_RE = /^VTMEM 2 (\d+) ([01]) (ok|no-cgroup2|no-user-systemd)$/;
const SCOPE_RE = /^(?:-)$|^tmux-spawn-[^/\t]+\.scope$/;
const SOURCE_RE = /^(cgroup|rss|none)$/;

export type SamplerHeaderReason = 'ok' | 'no-cgroup2' | 'no-user-systemd';

export class SamplerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SamplerParseError';
  }
}

export interface SamplerParseResult {
  limitsSupported: boolean;
  uid: number;
  reason?: SamplerHeaderReason;
  panes: PaneScopeSample[];
}

function parseUint(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new SamplerParseError(`invalid ${label}: ${raw}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    throw new SamplerParseError(`invalid ${label}: ${raw}`);
  }
  return value;
}

function parseSwapMax(raw: string): { swapMax: number; swapUnknown?: boolean } {
  if (raw === '?') return { swapMax: 0, swapUnknown: true };
  return { swapMax: parseUint(raw, 'swapMax') };
}

function parsePaneLine(line: string): PaneScopeSample {
  const fields = line.split('\t');
  if (fields.length !== 10) {
    throw new SamplerParseError(`invalid pane line: ${line}`);
  }
  const [
    paneId,
    pidRaw,
    scopeRaw,
    currentRaw,
    highRaw,
    maxRaw,
    swapMaxRaw,
    oomRaw,
    managedRaw,
    sourceRaw,
  ] = fields;
  if (!paneId) {
    throw new SamplerParseError(`invalid pane id: ${line}`);
  }
  if (!SCOPE_RE.test(scopeRaw)) {
    throw new SamplerParseError(`invalid scope: ${scopeRaw}`);
  }
  if (managedRaw !== '0' && managedRaw !== '1') {
    throw new SamplerParseError(`invalid managed: ${managedRaw}`);
  }
  if (!SOURCE_RE.test(sourceRaw)) {
    throw new SamplerParseError(`invalid source: ${sourceRaw}`);
  }
  return {
    paneId,
    pid: parseUint(pidRaw, 'pid'),
    scope: scopeRaw === '-' ? null : scopeRaw,
    current: parseUint(currentRaw, 'current'),
    high: parseUint(highRaw, 'high'),
    max: parseUint(maxRaw, 'max'),
    ...parseSwapMax(swapMaxRaw),
    oomKills: parseUint(oomRaw, 'oomKill'),
    managed: managedRaw === '1',
    source: sourceRaw as PaneMemorySource,
  };
}

export function parseSamplerOutput(stdout: string): SamplerParseResult {
  const nonempty = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (nonempty.length === 0) {
    throw new SamplerParseError('empty sampler output');
  }
  const header = HEADER_RE.exec(nonempty[0]);
  if (!header) {
    throw new SamplerParseError(`invalid header: ${nonempty[0]}`);
  }
  const uid = Number.parseInt(header[1], 10);
  const limitsSupported = header[2] === '1';
  const reason = header[3] as SamplerHeaderReason;
  return {
    limitsSupported,
    uid,
    reason,
    panes: nonempty.slice(1).map(parsePaneLine),
  };
}
