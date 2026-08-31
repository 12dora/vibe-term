import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { t } from '../i18n';
import { writeTextAtomic } from './fs-utils';
import { isPidAlive, processStartIdentity } from './upgrade-lock';

export { isPidAlive };

export type UpgradeServiceControl = {
  stop: () => Promise<void>;
  start: () => Promise<void>;
  isRunning: () => Promise<boolean>;
};

export type PidRecord = {
  pid: number;
  identity?: string | null;
  runtimePath?: string;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message?: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleepMs(100);
  }
  throw new Error(message ?? `timed out after ${timeoutMs}ms`);
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  await waitUntil(
    () => !isPidAlive(pid),
    timeoutMs,
    `pid ${pid} did not exit within ${timeoutMs}ms`
  );
}

export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/cmdline`)) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export type KillPidProbes = {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  assertOwned?: () => void;
  waitExit?: (pid: number, timeoutMs: number) => Promise<void>;
};

export async function killPidAndWait(
  pid: number,
  timeoutMs: number,
  probes: KillPidProbes = {}
): Promise<void> {
  const isAlive = probes.isAlive ?? isPidAlive;
  const kill =
    probes.kill ??
    ((target: number, signal: NodeJS.Signals) => {
      process.kill(target, signal);
    });
  const waitExit = probes.waitExit ?? waitForPidExit;
  const assertOwned = probes.assertOwned;

  const trySignal = (signal: NodeJS.Signals): 'gone' | 'signaled' => {
    if (!isAlive(pid)) return 'gone';
    if (assertOwned) {
      try {
        assertOwned();
      } catch (error) {
        if (!isAlive(pid)) return 'gone';
        throw error;
      }
    }
    if (!isAlive(pid)) return 'gone';
    try {
      kill(pid, signal);
    } catch {
      return 'gone';
    }
    return 'signaled';
  };

  if (trySignal('SIGTERM') === 'gone') return;
  try {
    await waitExit(pid, Math.min(timeoutMs, 10_000));
  } catch {
    if (trySignal('SIGKILL') === 'gone') return;
    await waitExit(pid, timeoutMs);
  }
}

export function cmdlineOwnsRuntime(
  cmdline: string | null | undefined,
  runtimePaths: string[]
): boolean {
  if (!cmdline) return false;
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const exe = basename(tokens[0] ?? '');
  if (exe !== 'bun' && exe !== 'node') return false;
  const needles = new Set<string>();
  for (const path of runtimePaths) {
    if (!path) continue;
    needles.add(path);
    try {
      needles.add(realpathSync(path));
    } catch {
      // path may not exist yet (legacy layout before convert)
    }
  }
  for (const token of tokens.slice(1)) {
    if (needles.has(token)) return true;
    try {
      if (needles.has(realpathSync(token))) return true;
    } catch {
      // token is not a resolvable path
    }
  }
  return false;
}

export function commandLineContains(pid: number, needle: string): boolean {
  const cmd = processCommandLine(pid);
  return Boolean(cmd && needle && cmd.includes(needle));
}

function withRealpath(path: string): string[] {
  const out = [path];
  try {
    const resolved = realpathSync(path);
    if (resolved !== path) out.push(resolved);
  } catch {
    // path may not exist yet (legacy layout before convert)
  }
  return out;
}

export function ownedRuntimePaths(installDir: string): string[] {
  return [
    ...withRealpath(join(installDir, 'current', 'runtime', 'server.js')),
    ...withRealpath(join(installDir, 'runtime', 'server.js')),
  ];
}

export function parsePidRecord(raw: string): PidRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<PidRecord>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      identity: typeof parsed.identity === 'string' ? parsed.identity : null,
      runtimePath: typeof parsed.runtimePath === 'string' ? parsed.runtimePath : undefined,
    };
  } catch {
    return null;
  }
}

export function formatPidRecord(record: PidRecord): string {
  return `${JSON.stringify({
    pid: record.pid,
    identity: record.identity ?? processStartIdentity(record.pid),
    runtimePath: record.runtimePath,
  })}\n`;
}

export function readPidRecord(pidPath: string): PidRecord | null {
  try {
    return parsePidRecord(readFileSync(pidPath, 'utf8'));
  } catch {
    return null;
  }
}

export function pidFilePath(installDir: string): string {
  return join(installDir, 'tmex.pid');
}

export function assertOwnedInstallProcess(opts: {
  pid: number;
  installDir: string;
  expectedIdentity?: string | null;
  commandLine?: string | null;
}): void {
  const { pid, installDir } = opts;
  if (!isPidAlive(pid)) {
    throw new Error(t('upgrade.pidNotOwned', { pid: String(pid), installDir }));
  }
  if (opts.expectedIdentity) {
    const live = processStartIdentity(pid);
    if (live !== null && live !== opts.expectedIdentity) {
      throw new Error(t('upgrade.pidNotOwned', { pid: String(pid), installDir }));
    }
    if (live !== null && live === opts.expectedIdentity) {
      return;
    }
  }
  const cmd = opts.commandLine === undefined ? processCommandLine(pid) : opts.commandLine;
  if (!cmdlineOwnsRuntime(cmd, ownedRuntimePaths(installDir))) {
    throw new Error(t('upgrade.pidNotOwned', { pid: String(pid), installDir }));
  }
}

export function hasLivePidFile(installDir: string): boolean {
  const record = readPidRecord(pidFilePath(installDir));
  return record !== null && isPidAlive(record.pid);
}

export function hasOwnedLivePidFile(installDir: string): boolean {
  const record = readPidRecord(pidFilePath(installDir));
  if (!record || !isPidAlive(record.pid)) return false;
  try {
    assertOwnedInstallProcess({
      pid: record.pid,
      installDir,
      expectedIdentity: record.identity,
    });
    return true;
  } catch {
    return false;
  }
}

const STOP_TIMEOUT_MS = 20_000;

export function createDirectProcessControl(opts: {
  runScriptPath: string;
  pidPath: string;
  installDir: string;
  env?: NodeJS.ProcessEnv;
}): UpgradeServiceControl {
  const assertOwnedLive = (): PidRecord | null => {
    const record = readPidRecord(opts.pidPath);
    if (!record) return null;
    if (!isPidAlive(record.pid)) return record;
    assertOwnedInstallProcess({
      pid: record.pid,
      installDir: opts.installDir,
      expectedIdentity: record.identity,
    });
    return record;
  };

  return {
    async stop() {
      const record = assertOwnedLive();
      if (record && isPidAlive(record.pid)) {
        await killPidAndWait(record.pid, STOP_TIMEOUT_MS, {
          assertOwned: () => {
            assertOwnedInstallProcess({
              pid: record.pid,
              installDir: opts.installDir,
              expectedIdentity: record.identity,
            });
          },
        });
      }
      if (record && isPidAlive(record.pid)) {
        throw new Error(t('upgrade.serviceDidNotStop', { timeout: STOP_TIMEOUT_MS }));
      }
      await rm(opts.pidPath, { force: true }).catch(() => null);
    },
    async start() {
      const child = spawn('bash', [opts.runScriptPath], {
        detached: true,
        stdio: 'ignore',
        env: opts.env ?? process.env,
      });
      child.unref();
      if (child.pid) {
        const runtimePath = ownedRuntimePaths(opts.installDir)[0];
        await writeTextAtomic(
          opts.pidPath,
          formatPidRecord({
            pid: child.pid,
            identity: processStartIdentity(child.pid),
            runtimePath,
          })
        );
      }
    },
    async isRunning() {
      const record = readPidRecord(opts.pidPath);
      if (!record) return false;
      if (!isPidAlive(record.pid)) return false;
      assertOwnedInstallProcess({
        pid: record.pid,
        installDir: opts.installDir,
        expectedIdentity: record.identity,
      });
      return true;
    },
  };
}
