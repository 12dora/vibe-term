import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { UPGRADE_CANCELLED, type UpgradeState, type UpgradeStatus } from '@tmex/shared';
import { releaseTarballName } from '@tmex/shared';
import { processCommandLine, processStartIdentity } from '@tmex/shared/process';
import { parsePidFileRecord as parseSharedPidFileRecord } from '../../../../packages/shared/src/process/pid-file';
import { type InstallInfo, getInstallInfo } from './install-info';
import { downloadVerifiedRelease, resolveReleaseCacheDir, sha256File } from './release-download';
import {
  type StagePackageOpts,
  type StagePackageResult,
  type StagedPackageRecord,
  type StagedPackageStatusResult,
  fileSizeOrZero,
  resumeStagedPart,
  stagedPartExpired,
  stagedPartPath,
  truncatedTransfer,
} from './upgrade-staging';

export {
  assertReleaseIntegrity,
  fetchReleaseSha256Sums,
  parseSha256Sums,
  releaseSha256SumsUrl,
  sha256Hex,
} from './release-download';
export { processCommandLine, processStartIdentity };
export type {
  StagePackageOpts,
  StagePackageResult,
  StagedPackageRecord,
  StagedPackageStatusResult,
};

export const STAGED_PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
const STAGED_PACKAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STAGED_PACKAGE_MAX_COUNT = 2;
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
  stageRelease?: (stageDir: string, version: string, signal?: AbortSignal) => Promise<string>;
  extractPackage?: (tarballPath: string, stageDir: string, signal?: AbortSignal) => Promise<string>;
  processCommandLine?: ProcessCommandLineFn;
  processStartIdentity?: ProcessStartIdentityFn;
  maxPackageBytes?: number;
  now?: () => number;
};

export type UpgradeStartOpts = {
  source?: 'release' | 'staged';
  sha256?: string;
};

export type UpgradeStartResult =
  | { ok: true }
  | { ok: false; code: 'UPGRADE_IN_PROGRESS' | 'PACKAGE_NOT_STAGED' };

export type UpgradeCancelResult =
  | { ok: true; status: UpgradeStatus }
  | {
      ok: false;
      code: 'UPGRADE_NOT_CANCELLABLE' | 'UPGRADE_NOT_RUNNING';
      status: UpgradeStatus;
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
  private readonly staged = new Map<string, StagedPackageRecord>();
  private stagedLoaded = false;
  private stagingInFlight = false;
  private stagingVersion: string | null = null;
  private stagingKey: string | null = null;
  private stagingPreempt: (() => void) | null = null;
  private stagingDone: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private cancelRequested = false;
  private commitStarted = false;
  private activeTxnDir: string | null = null;
  private lock: Promise<void> = Promise.resolve();

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

  resetForTests(): void {
    this.state = 'idle';
    this.targetVersion = null;
    this.error = null;
    this.startedAt = null;
    this.pendingEarlyExit = null;
    this.staged.clear();
    this.stagedLoaded = false;
    this.stagingInFlight = false;
    this.stagingVersion = null;
    this.stagingKey = null;
    this.stagingPreempt = null;
    this.stagingDone = Promise.resolve();
    this.abort?.abort();
    this.abort = null;
    this.cancelRequested = false;
    this.commitStarted = false;
    this.activeTxnDir = null;
    this.lock = Promise.resolve();
  }

  /** 进入升级流程；返回 false 表示已忙（并发触发）。下载/执行异步进行，不阻塞调用方。 */
  start(version: string, opts?: UpgradeStartOpts): boolean {
    return this.tryStart(version, opts).ok;
  }

  tryStart(version: string, opts?: UpgradeStartOpts): UpgradeStartResult {
    if (this.isBusy() || this.stagingInFlight) return { ok: false, code: 'UPGRADE_IN_PROGRESS' };
    const source = opts?.source ?? 'release';
    let staged: StagedPackageRecord | null = null;
    if (source === 'staged') {
      staged = this.lookupStaged(version, opts?.sha256);
      if (!staged) return { ok: false, code: 'PACKAGE_NOT_STAGED' };
    }
    this.state = 'downloading';
    this.targetVersion = version;
    this.error = null;
    this.startedAt = new Date().toISOString();
    this.cancelRequested = false;
    this.commitStarted = false;
    this.abort = new AbortController();
    this.activeTxnDir = null;
    void this.run(version, opts, staged);
    return { ok: true };
  }

  async cancel(): Promise<UpgradeCancelResult> {
    return this.withLock(async () => {
      if (this.state === 'idle') {
        return { ok: false, code: 'UPGRADE_NOT_RUNNING' as const, status: this.status() };
      }
      if (this.state === 'executing' || this.commitStarted) {
        return { ok: false, code: 'UPGRADE_NOT_CANCELLABLE' as const, status: this.status() };
      }
      this.cancelRequested = true;
      this.abort?.abort();
      const txnDir = this.activeTxnDir;
      const version = this.targetVersion;
      const install = (this.deps.getInstallInfo ?? getInstallInfo)();
      const installDir = resolveUpgradeInstallDir(install);
      await this.cleanupCancelledUpgrade(installDir, txnDir, version);
      this.state = 'idle';
      this.error = UPGRADE_CANCELLED;
      this.targetVersion = null;
      this.activeTxnDir = null;
      this.abort = null;
      return { ok: true, status: this.status() };
    });
  }

  async removeStagedPackage(version: string): Promise<{ ok: true } | { ok: false; status: 404 }> {
    if (this.stagingVersion === version) {
      await this.stagingDone;
    }
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    if (!installDir) return { ok: false, status: 404 };
    this.loadStagedFromDisk(installDir);
    const record = this.staged.get(version);
    const stagedDir = join(installDir, 'staging', 'staged');
    const tgz = record?.path ?? join(stagedDir, releaseTarballName(version));
    const sidecar = join(stagedDir, `tmex-cli-${version}.json`);
    const parts = this.listStagedParts(stagedDir, version);
    const had = Boolean(record) || existsSync(tgz) || existsSync(sidecar) || parts.length > 0;
    if (!had) return { ok: false, status: 404 };
    this.staged.delete(version);
    await rm(tgz, { force: true }).catch(() => {});
    await rm(sidecar, { force: true }).catch(() => {});
    for (const part of parts) await rm(part, { force: true }).catch(() => {});
    return { ok: true };
  }

  /** 该版本遗留的所有续传半成品：取消 / 删除暂存包时要一并清掉。 */
  private listStagedParts(stagedDir: string, version: string): string[] {
    if (!existsSync(stagedDir)) return [];
    const prefix = `${releaseTarballName(version)}.part`;
    try {
      return readdirSync(stagedDir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(stagedDir, name));
    } catch {
      return [];
    }
  }

  /** 续传前的偏移查询：已完整暂存返回 `complete`，否则返回 `.part` 的当前长度。 */
  async stagedPackageStatus(version: string, sha256: string): Promise<StagedPackageStatusResult> {
    const expected = sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) return { ok: false, status: 400, code: 'BAD_REQUEST' };
    if (this.stagingVersion === version) await this.stagingDone;
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    if (!installDir) return { ok: false, status: 500, code: 'STAGE_FAILED' };
    const staged = this.lookupStaged(version, expected);
    if (staged) {
      return {
        ok: true,
        version,
        sha256: expected,
        receivedBytes: staged.bytes,
        complete: true,
      };
    }
    const stagedDir = join(installDir, 'staging', 'staged');
    return {
      ok: true,
      version,
      sha256: expected,
      receivedBytes: fileSizeOrZero(stagedPartPath(stagedDir, version, expected)),
      complete: false,
    };
  }

  async stagePackage(
    version: string,
    sha256: string,
    body: ReadableStream<Uint8Array> | null,
    opts?: StagePackageOpts
  ): Promise<StagePackageResult> {
    const key = `${version}:${sha256.trim().toLowerCase()}`;
    if (this.isBusy()) return { ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' };
    if (this.stagingInFlight) {
      // 同一个包的续传：上一条 PUT 多半挂在已经死掉的链路上，先把它顶掉再接手。
      if (this.stagingKey !== key) return { ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' };
      this.stagingPreempt?.();
      await this.stagingDone;
      if (this.isBusy() || this.stagingInFlight) {
        return { ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' };
      }
    }
    this.stagingInFlight = true;
    this.stagingVersion = version;
    this.stagingKey = key;
    let release!: () => void;
    this.stagingDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await this.stagePackageLocked(version, sha256, body, opts);
    } finally {
      this.stagingInFlight = false;
      this.stagingVersion = null;
      this.stagingKey = null;
      this.stagingPreempt = null;
      release();
    }
  }

  private async stagePackageLocked(
    version: string,
    sha256: string,
    body: ReadableStream<Uint8Array> | null,
    opts?: StagePackageOpts
  ): Promise<StagePackageResult> {
    const expected = sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { ok: false, status: 400, code: 'BAD_REQUEST' };
    }
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    if (!installDir) {
      return { ok: false, status: 500, code: 'STAGE_FAILED' };
    }
    if (!body) return { ok: false, status: 400, code: 'BAD_REQUEST' };

    await this.repairStagingArtifacts(installDir);
    const stagedDir = join(installDir, 'staging', 'staged');
    await mkdir(stagedDir, { recursive: true, mode: 0o700 });
    const partPath = stagedPartPath(stagedDir, version, expected);
    const maxBytes = this.deps.maxPackageBytes ?? STAGED_PACKAGE_MAX_BYTES;
    const hash = createHash('sha256');
    const resumed = await resumeStagedPart(partPath, opts?.offset ?? 0, maxBytes, hash);
    if (!resumed.ok) return resumed.result;

    const received = await this.receiveStagedBody({
      body,
      partPath,
      offset: resumed.offset,
      maxBytes,
      hash,
    });
    if (!received.ok) return received.result;
    const truncated = truncatedTransfer(received.bytes, opts?.expectedBytes);
    if (truncated) {
      // 半截包留在盘上等下一次续传，别把已经收到的十几兆一起扔掉。
      return { ok: false, status: 500, code: 'PACKAGE_INCOMPLETE', receivedBytes: received.bytes };
    }
    if (received.digest !== expected) {
      await rm(partPath, { force: true }).catch(() => {});
      return { ok: false, status: 400, code: 'PACKAGE_SHA256_MISMATCH' };
    }
    return this.commitStagedPackage(installDir, {
      version,
      sha256: expected,
      bytes: received.bytes,
      partPath,
    });
  }

  /**
   * 收包主循环。链路中断（read 抛错 / 被同包的新 PUT 顶掉）只关文件、**保留 `.part`**，
   * 下一次 PUT 带 offset 接着写；只有超限这种确定性失败才把半成品删掉。
   */
  private async receiveStagedBody(input: {
    body: ReadableStream<Uint8Array>;
    partPath: string;
    offset: number;
    maxBytes: number;
    hash: ReturnType<typeof createHash>;
  }): Promise<
    { ok: true; bytes: number; digest: string } | { ok: false; result: StagePackageResult }
  > {
    const { body, partPath, offset, maxBytes, hash } = input;
    let bytes = offset;
    const reader = body.getReader();
    let preempted = false;
    this.stagingPreempt = () => {
      preempted = true;
      void reader.cancel().catch(() => {});
    };
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(partPath, offset > 0 ? 'a' : 'w', 0o600);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await fh.close().catch(() => {});
          fh = null;
          await rm(partPath, { force: true });
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
          return { ok: false, result: { ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' } };
        }
        hash.update(value);
        await fh.write(value);
      }
      await fh.close();
      fh = null;
    } catch {
      await fh?.close().catch(() => {});
      return { ok: false, result: { ok: false, status: 500, code: 'STAGE_FAILED' } };
    } finally {
      this.stagingPreempt = null;
    }
    if (preempted) {
      return { ok: false, result: { ok: false, status: 500, code: 'STAGE_FAILED' } };
    }
    return { ok: true, bytes, digest: hash.digest('hex') };
  }

  private async commitStagedPackage(
    installDir: string,
    input: { version: string; sha256: string; bytes: number; partPath: string }
  ): Promise<StagePackageResult> {
    const { version, sha256, bytes, partPath } = input;
    const stagedDir = join(installDir, 'staging', 'staged');
    const finalPath = join(stagedDir, releaseTarballName(version));
    const sidecarPath = join(stagedDir, `tmex-cli-${version}.json`);
    let renamed = false;
    try {
      await rm(finalPath, { force: true }).catch(() => {});
      await rename(partPath, finalPath);
      renamed = true;
      await chmod(finalPath, 0o600).catch(() => {});
      const record: StagedPackageRecord = {
        version,
        sha256,
        path: finalPath,
        bytes,
        stagedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      };
      await writeFile(sidecarPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.loadStagedFromDisk(installDir);
      this.staged.set(version, record);
      await this.pruneStaged(installDir, version);
      return { ok: true, version, sha256, bytes };
    } catch {
      await rm(partPath, { force: true }).catch(() => {});
      if (renamed) await rm(finalPath, { force: true }).catch(() => {});
      await rm(sidecarPath, { force: true, recursive: true }).catch(() => {});
      return { ok: false, status: 500, code: 'STAGE_FAILED' };
    }
  }

  private lookupStaged(version: string, sha256?: string): StagedPackageRecord | null {
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    if (!installDir) return null;
    this.loadStagedFromDisk(installDir);
    this.dropExpiredStaged(installDir);
    const record = this.staged.get(version);
    if (!record) return null;
    if (!existsSync(record.path)) {
      this.staged.delete(version);
      return null;
    }
    const expected = sha256?.trim().toLowerCase();
    if (expected && expected !== record.sha256) return null;
    return record;
  }

  private loadStagedFromDisk(installDir: string): void {
    if (this.stagedLoaded) return;
    this.stagedLoaded = true;
    const stagedDir = join(installDir, 'staging', 'staged');
    if (!existsSync(stagedDir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(stagedDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          readFileSync(join(stagedDir, name), 'utf8')
        ) as Partial<StagedPackageRecord>;
        if (
          typeof parsed.version !== 'string' ||
          typeof parsed.sha256 !== 'string' ||
          typeof parsed.path !== 'string' ||
          typeof parsed.bytes !== 'number' ||
          typeof parsed.stagedAt !== 'string'
        ) {
          continue;
        }
        if (!existsSync(parsed.path)) {
          rmSync(join(stagedDir, name), { force: true });
          continue;
        }
        this.staged.set(parsed.version, {
          version: parsed.version,
          sha256: parsed.sha256.toLowerCase(),
          path: parsed.path,
          bytes: parsed.bytes,
          stagedAt: parsed.stagedAt,
        });
      } catch {
        // skip corrupt sidecar
      }
    }
  }

  private dropExpiredStaged(installDir: string): void {
    const now = (this.deps.now ?? Date.now)();
    for (const [version, record] of this.staged) {
      const at = Date.parse(record.stagedAt);
      if (!Number.isFinite(at) || now - at > STAGED_PACKAGE_TTL_MS) {
        this.staged.delete(version);
        void rm(record.path, { force: true }).catch(() => {});
        void rm(join(installDir, 'staging', 'staged', `tmex-cli-${version}.json`), {
          force: true,
        }).catch(() => {});
      }
    }
  }

  private async pruneStaged(installDir: string, keepVersion: string): Promise<void> {
    this.dropExpiredStaged(installDir);
    const records = [...this.staged.values()].sort(
      (a, b) => Date.parse(b.stagedAt) - Date.parse(a.stagedAt)
    );
    const keep = new Set<string>([keepVersion]);
    for (const record of records) {
      if (keep.size >= STAGED_PACKAGE_MAX_COUNT) break;
      keep.add(record.version);
    }
    for (const [version, record] of this.staged) {
      if (keep.has(version)) continue;
      this.staged.delete(version);
      await rm(record.path, { force: true }).catch(() => {});
      await rm(join(installDir, 'staging', 'staged', `tmex-cli-${version}.json`), {
        force: true,
      }).catch(() => {});
    }
    await this.pruneOrphanStagedFiles(installDir);
  }

  private async pruneOrphanStagedFiles(installDir: string): Promise<void> {
    const stagedDir = join(installDir, 'staging', 'staged');
    if (!existsSync(stagedDir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(stagedDir);
    } catch {
      return;
    }
    const keptPaths = new Set([...this.staged.values()].map((record) => record.path));
    const now = (this.deps.now ?? Date.now)();
    for (const name of names) {
      const path = join(stagedDir, name);
      if (name.includes('.part')) {
        // 断点续传的半成品要留着给下一次 PUT 接力，只清超过保留期的。
        if (stagedPartExpired(path, now)) {
          await rm(path, { force: true, recursive: true }).catch(() => {});
        }
        continue;
      }
      if (name.endsWith('.json')) {
        const version = name.startsWith('tmex-cli-')
          ? name.slice('tmex-cli-'.length, -'.json'.length)
          : '';
        const tgz = version ? join(stagedDir, releaseTarballName(version)) : '';
        if (!version || !existsSync(tgz) || !this.staged.has(version)) {
          await rm(path, { force: true }).catch(() => {});
        }
        continue;
      }
      if (name.endsWith('.tgz') && !keptPaths.has(path)) {
        await rm(path, { force: true }).catch(() => {});
      }
    }
  }

  private withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private async cleanupCancelledUpgrade(
    installDir: string | null,
    txnDir: string | null,
    version: string | null
  ): Promise<void> {
    if (txnDir) await rm(txnDir, { recursive: true, force: true }).catch(() => {});
    if (!installDir || !version) return;
    const cacheDir = resolveReleaseCacheDir(installDir);
    await rm(join(cacheDir, `${releaseTarballName(version)}.part`), { force: true }).catch(
      () => {}
    );
    const dest = join(cacheDir, releaseTarballName(version));
    if (!existsSync(`${dest}.sha256`)) {
      await rm(dest, { force: true }).catch(() => {});
    }
  }

  private async repairStagingArtifacts(installDir: string): Promise<void> {
    this.loadStagedFromDisk(installDir);
    this.dropExpiredStaged(installDir);
    await this.pruneOrphanStagedFiles(installDir);
    await this.pruneOrphanReleaseCache(installDir);
    await this.pruneOrphanTxnDirs(installDir);
  }

  private async pruneOrphanReleaseCache(installDir: string): Promise<void> {
    const cacheDir = resolveReleaseCacheDir(installDir);
    if (!existsSync(cacheDir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(cacheDir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(cacheDir, name);
      if (name.includes('.part')) {
        await rm(path, { force: true, recursive: true }).catch(() => {});
        continue;
      }
      if (name.endsWith('.tgz') && !existsSync(`${path}.sha256`)) {
        await rm(path, { force: true }).catch(() => {});
      }
    }
  }

  private async pruneOrphanTxnDirs(installDir: string): Promise<void> {
    const root = join(installDir, 'staging');
    if (!existsSync(root)) return;
    const keep = new Set(['staged', 'release-cache']);
    if (this.activeTxnDir) keep.add(basename(this.activeTxnDir));
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  private throwIfCancelled(): void {
    if (!this.cancelRequested && !this.abort?.signal.aborted) return;
    const err = new Error(UPGRADE_CANCELLED);
    err.name = 'AbortError';
    throw err;
  }

  private async run(
    version: string,
    opts?: UpgradeStartOpts,
    staged?: StagedPackageRecord | null
  ): Promise<void> {
    const install = (this.deps.getInstallInfo ?? getInstallInfo)();
    const installDir = resolveUpgradeInstallDir(install);
    let stageDir: string | null = null;
    const signal = this.abort?.signal;

    try {
      if (!installDir) {
        throw new Error('install directory could not be resolved');
      }

      await this.repairStagingArtifacts(installDir);
      this.throwIfCancelled();

      const txnId = createTxnId();
      stageDir = join(installDir, 'staging', txnId);
      this.activeTxnDir = stageDir;
      await mkdir(stageDir, { recursive: true, mode: 0o700 });
      const source = opts?.source ?? 'release';
      let binPath: string;
      if (source === 'staged') {
        const record = staged ?? this.lookupStaged(version, opts?.sha256);
        if (!record) throw new Error('PACKAGE_NOT_STAGED');
        const consumedPath = join(stageDir, releaseTarballName(version));
        this.staged.delete(version);
        await rm(join(installDir, 'staging', 'staged', `tmex-cli-${version}.json`), {
          force: true,
        });
        await rename(record.path, consumedPath);
        this.throwIfCancelled();
        const hashed = await sha256File(consumedPath);
        if (hashed.sha256 !== record.sha256) {
          throw new Error('PACKAGE_SHA256_MISMATCH');
        }
        const expected = opts?.sha256?.trim().toLowerCase();
        if (expected && expected !== hashed.sha256) {
          throw new Error('PACKAGE_SHA256_MISMATCH');
        }
        this.throwIfCancelled();
        const extractPackage = this.deps.extractPackage ?? extractCliTarball;
        binPath = await extractPackage(consumedPath, stageDir, signal);
      } else {
        const stageRelease = this.deps.stageRelease ?? stageGithubRelease;
        binPath = await stageRelease(stageDir, version, signal);
      }
      this.throwIfCancelled();
      const committed = await this.withLock(() => {
        if (this.cancelRequested || this.state !== 'downloading') return false;
        this.commitStarted = true;
        return true;
      });
      if (!committed) {
        await this.cleanupCancelledUpgrade(installDir, stageDir, version);
        return;
      }
      await this.spawnUpgrade(binPath, installDir, version, txnId);
      await this.withLock(() => {
        if (this.state !== 'downloading') return;
        this.state = 'executing';
        if (this.pendingEarlyExit) {
          this.error = this.pendingEarlyExit;
          this.state = 'idle';
          this.pendingEarlyExit = null;
        }
      });
    } catch (err) {
      await this.withLock(async () => {
        if (this.cancelRequested || this.error === UPGRADE_CANCELLED) {
          await this.cleanupCancelledUpgrade(installDir, stageDir, version);
          return;
        }
        this.error = err instanceof Error ? err.message : String(err);
        this.state = 'idle';
        this.targetVersion = null;
        this.activeTxnDir = null;
      });
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

export type PidFileRecord = { pid: number; identity?: string | null };

export function parsePidFileRecord(raw: string): PidFileRecord | null {
  const record = parseSharedPidFileRecord(raw, { allowNumericStringPid: true });
  return record ? { pid: record.pid, identity: record.identity ?? null } : null;
}

/**
 * 下载 GitHub Release tarball 并解压到 stageDir（npm pack 布局：package/）。
 * 返回 CLI 入口路径 `<stageDir>/package/bin/tmex.js`。
 */
export async function stageGithubRelease(
  stageDir: string,
  version: string,
  signal?: AbortSignal
): Promise<string> {
  const installDir = resolveUpgradeInstallDir(getInstallInfo());
  const cached = await downloadVerifiedRelease(version, {
    cacheDir: resolveReleaseCacheDir(installDir),
    signal,
  });
  if (signal?.aborted) {
    const err = new Error(UPGRADE_CANCELLED);
    err.name = 'AbortError';
    throw err;
  }
  return extractCliTarball(cached.path, stageDir, signal);
}

export async function extractCliTarball(
  tarballPath: string,
  stageDir: string,
  signal?: AbortSignal
): Promise<string> {
  await extractTarball(tarballPath, stageDir, signal);
  const packageRoot = join(stageDir, 'package');
  const binPath = join(packageRoot, 'bin', 'tmex.js');
  if (!existsSync(binPath)) {
    throw new Error(`downloaded tmex-cli binary not found at ${binPath}`);
  }
  assertExtractedCliPackage(packageRoot);
  return binPath;
}

function extractTarball(
  tarballPath: string,
  stageDir: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const child = spawn('tar', ['-xzf', tarballPath, '-C', stageDir], {
      stdio: 'ignore',
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
      const err = new Error(UPGRADE_CANCELLED);
      err.name = 'AbortError';
      finish(() => reject(err));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      finish(() => reject(err));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) finish(() => resolve());
      else finish(() => reject(new Error(`tar extract exited with code ${code ?? 'null'}`)));
    });
  });
}

export const upgradeController = new UpgradeController();
