import type { PaneScopeSample } from './types';

const HEADER_RE = /^VTMEM 1 (\d+) ([01])$/;
const SCOPE_RE = /^(?:-)$|^tmux-spawn-[^/\t]+\.scope$/;

export class SamplerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SamplerParseError';
  }
}

export interface SamplerParseResult {
  supported: boolean;
  uid: number;
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

function parsePaneLine(line: string): PaneScopeSample {
  const fields = line.split('\t');
  if (fields.length !== 9) {
    throw new SamplerParseError(`invalid pane line: ${line}`);
  }
  const [paneId, pidRaw, scopeRaw, currentRaw, highRaw, maxRaw, swapMaxRaw, oomRaw, managedRaw] =
    fields;
  if (!paneId) {
    throw new SamplerParseError(`invalid pane id: ${line}`);
  }
  if (!SCOPE_RE.test(scopeRaw)) {
    throw new SamplerParseError(`invalid scope: ${scopeRaw}`);
  }
  if (managedRaw !== '0' && managedRaw !== '1') {
    throw new SamplerParseError(`invalid managed: ${managedRaw}`);
  }
  return {
    paneId,
    pid: parseUint(pidRaw, 'pid'),
    scope: scopeRaw === '-' ? null : scopeRaw,
    current: parseUint(currentRaw, 'current'),
    high: parseUint(highRaw, 'high'),
    max: parseUint(maxRaw, 'max'),
    swapMax: parseUint(swapMaxRaw, 'swapMax'),
    oomKills: parseUint(oomRaw, 'oomKill'),
    managed: managedRaw === '1',
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
  const supported = header[2] === '1';
  if (!supported) {
    if (nonempty.length > 1) {
      throw new SamplerParseError('unsupported output must be header-only');
    }
    return { supported: false, uid, panes: [] };
  }
  return {
    supported: true,
    uid,
    panes: nonempty.slice(1).map(parsePaneLine),
  };
}
