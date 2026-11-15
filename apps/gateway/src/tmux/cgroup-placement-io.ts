import { access, readFile } from 'node:fs/promises';

import { runLocalHostShell } from '../window-memory/local-host-shell';
import { argvToScript } from '../window-memory/scope-commands';
import type { HostShellResult } from '../window-memory/types';
import { withUserBus } from '../window-memory/user-bus';

export const PLACEMENT_TIMEOUT_MS = 5_000;

const SYSTEMD_DEST = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER = 'org.freedesktop.systemd1.Manager';

export interface PlacementIo {
  platform: NodeJS.Platform;
  uid: number;
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  runShell(script: string, opts: { timeoutMs: number }): Promise<HostShellResult>;
  sleep(ms: number): Promise<void>;
}

export const defaultPlacementIo: PlacementIo = {
  platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  env: process.env,
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  runShell: (script, opts) => runLocalHostShell(script, opts),
  sleep: (ms) => Bun.sleep(ms),
};

export function buildProbeScript(): string {
  return withUserBus(
    [
      "command -v busctl >/dev/null 2>&1 || { printf '%s\\n' 'VTPLACE no-busctl'; exit 0; }",
      `${argvToScript(['busctl', '--user', 'get-property', SYSTEMD_DEST, SYSTEMD_PATH, SYSTEMD_MANAGER, 'Version'])} >/dev/null 2>&1 || { printf '%s\\n' 'VTPLACE no-user-manager'; exit 0; }`,
      "printf '%s\\n' 'VTPLACE ok'",
    ].join('\n')
  );
}

export function parseProbeOutput(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.startsWith('VTPLACE '));
  if (!line) return 'probe-failed';
  return line.slice('VTPLACE '.length) || 'probe-failed';
}

export interface StartScopeRequest {
  unit: string;
  slice: string;
  pids: readonly number[];
  description: string;
}

export function buildStartScopeScript(request: StartScopeRequest): string {
  return withUserBus(
    argvToScript([
      'busctl',
      '--user',
      'call',
      SYSTEMD_DEST,
      SYSTEMD_PATH,
      SYSTEMD_MANAGER,
      'StartTransientUnit',
      'ssa(sv)a(sa(sv))',
      request.unit,
      'fail',
      '5',
      'PIDs',
      'au',
      String(request.pids.length),
      ...request.pids.map(String),
      'Slice',
      's',
      request.slice,
      'CollectMode',
      's',
      'inactive-or-failed',
      'Description',
      's',
      request.description,
      'Delegate',
      'b',
      'true',
      '0',
    ])
  );
}

export function buildAttachScript(unit: string, pids: readonly number[]): string {
  return withUserBus(
    argvToScript([
      'busctl',
      '--user',
      'call',
      SYSTEMD_DEST,
      SYSTEMD_PATH,
      SYSTEMD_MANAGER,
      'AttachProcessesToUnit',
      'ssau',
      unit,
      '/',
      String(pids.length),
      ...pids.map(String),
    ])
  );
}

export function isUnitExistsError(stderr: string): boolean {
  return /already exists|UnitExists/i.test(stderr);
}
