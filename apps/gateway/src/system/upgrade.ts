import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { UpgradeState, UpgradeStatus } from '@tmex/shared';
import { releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { type InstallInfo, getInstallInfo } from './install-info';
import { compareVersions } from './semver';

const CHECKSUMS_REQUIRED_SINCE = '1.1.4';

const TARBALL_FETCH_TIMEOUT_MS = 120_000;

function createTxnId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** Prefer TMEX_INSTALL_DIR (run.sh) so a current/resources/fe-dist layout still resolves. */
export function resolveUpgradeInstallDir(install: InstallInfo): string | null {
  const fromEnv = process.env.TMEX_INSTALL_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dir = install.installDir;
  if (!dir) return null;
  if (existsSync(join(dir, 'install-meta.json'))) return dir;
  if (basename(dir) === 'current' && existsSync(join(dirname(dir), 'install-meta.json'))) {
    return dirname(dir);
  }
  return dir;
}

export type UpgradeSpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2]
) => ChildProcess;

export type ProcessCommandLineFn = (pid: number) => string | null;

export type ProcessStartIdentityFn = (pid: number) => string | null;

export type UpgradeControllerDeps = {
  spawn?: UpgradeSpawnFn;
  getInstallInfo?: () => InstallInfo;
  stageRelease?: (stageDir: string, version: string) => Promise<string>;
  processCommandLine?: ProcessCommandLineFn;
  processStartIdentity?: ProcessStartIdentityFn;
};

/**
 * 全局唯一升级状态机：idle / downloading / executing。
 *
 * 触发流程（仅 canSelfUpdate 由 API 层校验）：
 *  1. downloading：从本仓库 GitHub Releases 下载 `tmex-cli-<version>.tgz`
 *     到临时目录（fetch 跟随 GitHub 资产 302），再 `tar -xzf` 解出 npm pack
 *     布局（`package/`）。CLI 为 bun bundle，无需 npm install。此阶段失败时
 *     gateway 仍存活，可经 status() 上报 error 并回到 idle。
 *  2. executing：detached 拉起解压包的 `package/bin/tmex.js upgrade --apply-current-package`，
 *     子进程停服务（杀掉本 gateway）→ 部署 → 重启。服务重启后新 gateway 启动即 idle。
 *
 * 依赖服务 unit 的 KillMode=process / AbandonProcessGroup=true，使 detached 子进程
 * 在服务进程被停止时存活，完成自升级。
 */

function readNoneModePidRecord(installDir: string): PidFileRecord | null {
  try {
    return parsePidFileRecord(readFileSync(join(installDir, 'tmex.pid'), 'utf8'));
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function identityMatches(
  pid: number,
  expected: string,
  readIdentity: ProcessStartIdentityFn
): boolean | null {
  try {
    const live = readIdentity(pid);
    if (live === null) return null;
    return live === expected;
  } catch {
    return null;
  }
}

export class UpgradeController {
  private state: UpgradeState = 'idle';
  private targetVersion: string | null = null;
  private error: string | null = null;
  private startedAt: string | null = null;

  constructor(private readonly deps: UpgradeControllerDeps = {}) {}

  status(): UpgradeStatus {
    return {
      state: this.state,
      targetVersion: this.targetVersion,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  isBusy(): boolean {
    return this.state !== 'idle';
  }

  /** 进入升级流程；返回 false 表示已忙（并发触发）。下载/执行异步进行，不阻塞调用方。 */
  start(version: string): boolean {
    if (this.isBusy()) return false;
    this.state = 'downloading';
    this.targetVersion = version;
    this.error = null;
    this.startedAt = new Date().toISOString();
    void this.run(version);
    return true;
  }

  private async run(version: string): Promise<void> {
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    let stageDir: string | null = null;

    try {
      if (!installDir) {
        throw new Error('install directory could not be resolved');
      }

      const txnId = createTxnId();
      stageDir = join(installDir, 'staging', txnId);
      await mkdir(stageDir, { recursive: true });
      const stageRelease = this.deps.stageRelease ?? stageGithubRelease;
      const binPath = await stageRelease(stageDir, version);
      await this.spawnUpgrade(binPath, installDir, version, txnId);
      this.state = 'executing';
      if (this.pendingEarlyExit) {
        this.error = this.pendingEarlyExit;
        this.state = 'idle';
        this.pendingEarlyExit = null;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.state = 'idle';
      this.targetVersion = null;
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnedChild: ChildProcess | null = null;
  private pendingEarlyExit: string | null = null;

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const message = `upgrade process exited early (code ${code ?? signal})`;
    if (this.state === 'executing') {
      this.error = message;
      this.state = 'idle';
      return;
    }
    this.pendingEarlyExit = message;
  }

  private readPersistedServiceMode(installDir: string): 'managed' | 'none' {
    try {
      const parsed = JSON.parse(readFileSync(join(installDir, 'install-meta.json'), 'utf8')) as {
        serviceMode?: unknown;
      };
      return parsed.serviceMode === 'none' ? 'none' : 'managed';
    } catch {
      return 'managed';
    }
  }

  private assertNoneModePidOwnership(installDir: string): void {
    const record = readNoneModePidRecord(installDir);
    const pid = record?.pid ?? null;
    if (!record || pid === null || !pidIsAlive(pid)) {
      throw new Error(
        'This install is not managed by a service (serviceMode=none) and has no live pid file. Stop the running process, then retry.'
      );
    }
    if (record.identity) {
      const owned = identityMatches(
        pid,
        record.identity,
        this.deps.processStartIdentity ?? processStartIdentity
      );
      if (owned === true) return;
      if (owned === false) {
        throw new Error(`PID ${pid} is not the tmex runtime for this install (${installDir}).`);
      }
    }
    const readCmd = this.deps.processCommandLine ?? processCommandLine;
    let cmdline: string | null = null;
    try {
      cmdline = readCmd(pid);
    } catch {
      cmdline = null;
    }
    if (!cmdline || !cmdlineOwnsInstallRuntime(cmdline, installDir)) {
      throw new Error(`PID ${pid} is not the tmex runtime for this install (${installDir}).`);
    }
  }

  private spawnUpgrade(
    binPath: string,
    installDir: string,
    version: string,
    txnId: string
  ): Promise<void> {
    const mode = this.readPersistedServiceMode(installDir);
    if (mode === 'none') {
      this.assertNoneModePidOwnership(installDir);
    }

    let logFd: number | null = null;
    try {
      logFd = openSync(join(installDir, 'upgrade.log'), 'a');
    } catch {
      logFd = null;
    }

    const closeLog = (): void => {
      if (logFd === null) return;
      try {
        closeSync(logFd);
      } catch {}
      logFd = null;
    };

    try {
      const spawnFn = this.deps.spawn ?? spawn;
      const args = [
        binPath,
        'upgrade',
        '--apply-current-package',
        '--install-dir',
        installDir,
        '--version',
        version,
        '--txn',
        txnId,
        '--bun-path',
        process.execPath,
      ];
      if (mode === 'none') args.push('--no-service');
      const child = spawnFn(process.execPath, args, {
        cwd: installDir,
        env: process.env,
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      });
      this.spawnedChild = child;
      child.once('exit', (code, signal) => this.onChildExit(code, signal));

      return waitForSpawnAndDetach(child, closeLog);
    } catch (error) {
      closeLog();
      throw error;
    }
  }
}

export function waitForSpawnAndDetach(child: ChildProcess, onSettled?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      onSettled?.();
      fn();
    };
    child.once('error', (err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
    child.once('spawn', () => {
      finish(() => {
        child.unref();
        resolve();
      });
    });
  });
}

function hasBinEntry(bin: unknown): boolean {
  if (typeof bin === 'string' && bin.length > 0) return true;
  if (typeof bin !== 'object' || bin === null) return false;
  return Object.keys(bin as Record<string, unknown>).length > 0;
}

/** 解压后的 npm pack 布局必须能通过 resolvePackageLayout 的路径检查。 */
export function assertExtractedCliPackage(packageRoot: string): void {
  const pkgPath = join(packageRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`extracted package.json not found at ${pkgPath}`);
  }
  let parsed: { name?: unknown; bin?: unknown };
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; bin?: unknown };
  } catch {
    throw new Error(`extracted package.json is invalid at ${pkgPath}`);
  }
  if (parsed.name !== 'tmex-cli') {
    throw new Error(`extracted package name is ${String(parsed.name)}, expected tmex-cli`);
  }
  if (!hasBinEntry(parsed.bin)) {
    throw new Error('extracted package.json is missing a bin entry');
  }

  const required = [
    join(packageRoot, 'dist', 'cli-node.js'),
    join(packageRoot, 'dist', 'runtime', 'server.js'),
    join(packageRoot, 'resources', 'fe-dist'),
    join(packageRoot, 'resources', 'gateway-drizzle'),
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      throw new Error(`extracted package is missing ${path}`);
    }
  }
}

const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

export function parseSha256Sums(text: string, fileName: string): string | null {
  const want = basename(fileName);
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(SUM_LINE);
    if (!match) continue;
    if (basename(match[2]) === want) return match[1].toLowerCase();
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    const procPath = `/proc/${pid}/cmdline`;
    if (existsSync(procPath)) {
      try {
        return readFileSync(procPath, 'utf8').replace(/\0/g, ' ').trim() || null;
      } catch {
        return null;
      }
    }
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function processStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = stat.slice(close + 2).split(' ');
      return rest[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolvedPathOrSelf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function cmdlineOwnsInstallRuntime(cmdline: string, installDir: string): boolean {
  const needles = [
    join(installDir, 'current', 'runtime', 'server.js'),
    join(installDir, 'runtime', 'server.js'),
  ];
  const resolvedInstall = resolvedPathOrSelf(installDir);
  if (resolvedInstall && resolvedInstall !== installDir) {
    needles.push(
      join(resolvedInstall, 'current', 'runtime', 'server.js'),
      join(resolvedInstall, 'runtime', 'server.js')
    );
  }
  for (const needle of [...needles]) {
    const resolved = resolvedPathOrSelf(needle);
    if (resolved && resolved !== needle) needles.push(resolved);
  }
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const exe = basename(tokens[0] ?? '');
  if (exe !== 'bun' && exe !== 'node') return false;
  const needleSet = new Set(needles);
  for (const token of tokens.slice(1)) {
    if (needleSet.has(token)) return true;
    const resolved = resolvedPathOrSelf(token);
    if (resolved && needleSet.has(resolved)) return true;
  }
  return false;
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  return null;
}

export type PidFileRecord = { pid: number; identity?: string | null };

export function parsePidFileRecord(raw: string): PidFileRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = asPositiveInt(trimmed);
  if (direct !== null) return { pid: direct };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'pid' in parsed) {
      const pid = asPositiveInt((parsed as { pid: unknown }).pid);
      if (pid === null) return null;
      const identity = (parsed as { identity?: unknown }).identity;
      return {
        pid,
        identity: typeof identity === 'string' ? identity : null,
      };
    }
    const pid = asPositiveInt(parsed);
    return pid !== null ? { pid } : null;
  } catch {
    return null;
  }
}

export function parsePidFileContents(raw: string): number | null {
  return parsePidFileRecord(raw)?.pid ?? null;
}

export function assertReleaseIntegrity(
  version: string,
  bytes: Uint8Array,
  sums: { hex: string | null; missing: boolean }
): void {
  if (sums.missing || !sums.hex) {
    if (compareVersions(version, CHECKSUMS_REQUIRED_SINCE) >= 0) {
      throw new Error(
        `Release ${version} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue.`
      );
    }
    throw new Error('Release SHA256SUMS is missing; tarball integrity is unverified.');
  }
  if (sha256Hex(bytes) !== sums.hex) {
    throw new Error(`Release tarball sha256 mismatch for ${releaseTarballName(version)}.`);
  }
}

export function releaseSha256SumsUrl(version: string): string {
  return releaseTarballUrl(version).replace(releaseTarballName(version), 'SHA256SUMS');
}

export async function fetchReleaseSha256Sums(
  version: string,
  fileName: string,
  fetchFn: typeof fetch = fetch
): Promise<{ hex: string | null; missing: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(releaseSha256SumsUrl(version), {
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SHA256SUMS network error: ${detail}`);
  }
  if (response.status === 404) return { hex: null, missing: true };
  if (!response.ok) {
    throw new Error(`SHA256SUMS HTTP ${response.status}`);
  }
  const hex = parseSha256Sums(await response.text(), fileName || releaseTarballName(version));
  if (!hex) {
    throw new Error(`SHA256SUMS does not list ${fileName}`);
  }
  return { hex, missing: false };
}

/**
 * 下载 GitHub Release tarball 并解压到 stageDir（npm pack 布局：package/）。
 * 返回 CLI 入口路径 `<stageDir>/package/bin/tmex.js`。
 */
export async function stageGithubRelease(stageDir: string, version: string): Promise<string> {
  const tarballPath = join(stageDir, releaseTarballName(version));
  await downloadReleaseTarball(releaseTarballUrl(version), tarballPath);
  const bytes = readFileSync(tarballPath);
  const sums = await fetchReleaseSha256Sums(version, releaseTarballName(version));
  assertReleaseIntegrity(version, bytes, sums);
  await extractTarball(tarballPath, stageDir);

  const packageRoot = join(stageDir, 'package');
  const binPath = join(packageRoot, 'bin', 'tmex.js');
  if (!existsSync(binPath)) {
    throw new Error(`downloaded tmex-cli binary not found at ${binPath}`);
  }
  assertExtractedCliPackage(packageRoot);
  return binPath;
}

async function downloadReleaseTarball(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub release tarball HTTP ${res.status}`);
  }
  await writeFile(destPath, new Uint8Array(await res.arrayBuffer()));
}

function extractTarball(tarballPath: string, stageDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarballPath, '-C', stageDir], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract exited with code ${code ?? 'null'}`));
    });
  });
}

export const upgradeController = new UpgradeController();
