import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeState, UpgradeStatus } from '@tmex/shared';
import { releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { getInstallInfo } from './install-info';

const TARBALL_FETCH_TIMEOUT_MS = 120_000;

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
class UpgradeController {
  private state: UpgradeState = 'idle';
  private targetVersion: string | null = null;
  private error: string | null = null;
  private startedAt: string | null = null;

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
    const install = getInstallInfo();
    const installDir = install.installDir;
    let stageDir: string | null = null;

    try {
      if (!installDir) {
        throw new Error('install directory could not be resolved');
      }

      stageDir = await mkdtemp(join(tmpdir(), 'tmex-upg-'));

      // 校验下载产物：detached 子进程无法回报错误，缺二进制时趁本进程仍存活报错回 idle。
      const binPath = await stageGithubRelease(stageDir, version);

      // 阶段 2：执行（detached，脱离服务进程组）。此后服务会被重启，本进程随之退出，
      // 临时目录交由系统 tmp 回收，不在此清理（清理会与子进程读包竞争）。
      this.state = 'executing';
      this.spawnUpgrade(binPath, installDir, version);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.state = 'idle';
      this.targetVersion = null;
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnUpgrade(binPath: string, installDir: string, version: string): void {
    // 升级日志单独落盘，便于回滚等失败场景排查（detached 子进程的输出不会进服务日志）。
    let logFd: number | null = null;
    try {
      logFd = openSync(join(installDir, 'upgrade.log'), 'a');
    } catch {
      logFd = null;
    }

    const child = spawn(
      process.execPath,
      [
        binPath,
        'upgrade',
        '--apply-current-package',
        '--install-dir',
        installDir,
        '--version',
        version,
        // gateway 运行于 bun，process.execPath 即正确 bun：显式传给 cli，免其重新探测。
        '--bun-path',
        process.execPath,
      ],
      {
        cwd: installDir,
        env: process.env,
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      }
    );
    child.unref();
    if (logFd !== null) closeSync(logFd);
  }
}

/**
 * 下载 GitHub Release tarball 并解压到 stageDir（npm pack 布局：package/）。
 * 返回 CLI 入口路径 `<stageDir>/package/bin/tmex.js`。
 */
export async function stageGithubRelease(stageDir: string, version: string): Promise<string> {
  const tarballPath = join(stageDir, releaseTarballName(version));
  await downloadReleaseTarball(releaseTarballUrl(version), tarballPath);
  await extractTarball(tarballPath, stageDir);

  const binPath = join(stageDir, 'package', 'bin', 'tmex.js');
  if (!existsSync(binPath)) {
    throw new Error(`downloaded tmex-cli binary not found at ${binPath}`);
  }
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
