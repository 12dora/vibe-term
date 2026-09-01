import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartUninstallRequest, UninstallStatus, UpgradeState } from '@tmex/shared';
import { json } from '../api/http';
import { isManagedExternally } from './info-public';
import { type InstallInfo, getInstallInfo } from './install-info';
import { upgradeController, waitForSpawnAndDetach } from './upgrade';

export const UNINSTALL_SPAWN_DELAY_MS = 1500;

export type UninstallSpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2]
) => ChildProcess;

export type UninstallControllerDeps = {
  spawn?: UninstallSpawnFn;
  getInstallInfo?: () => InstallInfo;
  getUpgradeState?: () => UpgradeState;
  isManaged?: () => boolean;
  tmpdir?: () => string;
  randomId?: () => string;
  copyDir?: (src: string, dest: string) => void;
  now?: () => number;
};

declare const TMEX_MANAGED_BUILD: boolean | undefined;

function isManagedBuild(): boolean {
  return typeof TMEX_MANAGED_BUILD !== 'undefined' && TMEX_MANAGED_BUILD === true;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return waitForSpawnAndDetach(child);
}

export function resolveInstalledCliDir(installDir: string): string {
  const current = join(installDir, 'current');
  if (existsSync(current)) {
    try {
      return join(realpathSync(current), 'cli');
    } catch {
      return join(current, 'cli');
    }
  }
  return join(installDir, 'cli');
}

export class UninstallController {
  private state: UninstallStatus['state'] = 'idle';
  private startedAt: string | null = null;
  private error: string | null = null;
  private deps: UninstallControllerDeps;

  constructor(deps: UninstallControllerDeps = {}) {
    this.deps = deps;
  }

  setDepsForTests(deps: UninstallControllerDeps): void {
    this.deps = deps;
  }

  resetForTests(): void {
    this.state = 'idle';
    this.startedAt = null;
    this.error = null;
    this.deps = {};
  }

  status(): UninstallStatus {
    return { state: this.state, startedAt: this.startedAt, error: this.error };
  }

  async start(): Promise<Response> {
    if (this.state === 'scheduled') {
      return json(this.status(), 202);
    }

    const blocked = this.preflight();
    if (blocked) return blocked;

    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = install.installDir;
    if (!installDir) {
      return json({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'not_cli_install' }, 409);
    }

    const startedAt = new Date(this.now()).toISOString();
    this.state = 'scheduled';
    this.startedAt = startedAt;
    this.error = null;

    try {
      await this.spawnUninstall(installDir, install.serviceName);
    } catch (err) {
      this.state = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
      return json(this.status(), 500);
    }
    return json(this.status(), 202);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private preflight(): Response | null {
    const managed = this.deps.isManaged ?? (() => isManagedBuild() || isManagedExternally());
    if (managed()) {
      return json({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'managed' }, 409);
    }
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    if (!install.installedViaCli) {
      return json({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'not_cli_install' }, 409);
    }
    if (install.deployment === 'none') {
      return json({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'no_service_manager' }, 409);
    }
    const upgradeState = this.deps.getUpgradeState?.() ?? upgradeController.status().state;
    if (upgradeState === 'downloading' || upgradeState === 'executing') {
      return json({ code: 'UPGRADE_IN_PROGRESS' }, 409);
    }
    return null;
  }

  private async spawnUninstall(installDir: string, serviceName: string | null): Promise<void> {
    const cliDir = resolveInstalledCliDir(installDir);
    const cliEntry = join(cliDir, 'bin', 'tmex.js');
    if (!existsSync(cliEntry)) {
      throw new Error(`installed CLI not found at ${cliEntry}`);
    }
    const id = this.deps.randomId?.() ?? randomBytes(8).toString('hex');
    const dest = join(this.deps.tmpdir?.() ?? osTmpdir(), `tmex-uninstall-${id}`);
    const copyDir =
      this.deps.copyDir ?? ((src, target) => cpSync(src, target, { recursive: true }));
    copyDir(cliDir, dest);
    const binPath = join(dest, 'bin', 'tmex.js');
    const args = [binPath, 'uninstall', '--yes', '--purge', '--install-dir', installDir];
    if (serviceName) {
      args.push('--service-name', serviceName);
    }
    args.push('--delay-ms', String(UNINSTALL_SPAWN_DELAY_MS));
    const spawnFn = this.deps.spawn ?? spawn;
    const child = spawnFn(process.execPath, args, {
      cwd: installDir,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    await waitForSpawn(child);
  }
}

export const uninstallController = new UninstallController();

export async function startLocalUninstall(req: Request): Promise<Response> {
  let mode: unknown = 'full';
  try {
    const body = (await req.json()) as StartUninstallRequest;
    if (body && typeof body === 'object' && body.mode !== undefined) {
      mode = body.mode;
    }
  } catch {
    // empty / non-JSON body defaults to full
  }
  if (mode !== 'full') {
    return json({ error: 'mode must be full' }, 400);
  }
  return uninstallController.start();
}

export function readLocalUninstallStatus(): UninstallStatus {
  return uninstallController.status();
}
