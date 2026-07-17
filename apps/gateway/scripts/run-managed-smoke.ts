/**
 * 在干净临时 cwd 中启动 managed compiled gateway 并探测 health / system / ws。
 *
 * 约束：无 Bun PATH、无 JS/TS/node_modules/fe-dist、无 production env。
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanManagedArtifact } from './scan-managed-artifact';

function freePort(): number {
  // 任务临时端口：高位随机，避免 9883/生产。
  return 30000 + Math.floor(Math.random() * 20000);
}

async function waitHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await Bun.sleep(200);
  }
  return false;
}

async function main(): Promise<void> {
  const artifactArg = process.argv[2];
  const gatewayRoot = resolve(import.meta.dir, '..');
  const defaultArtifact = join(
    gatewayRoot,
    'dist-managed',
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'tmex-gateway-managed-darwin-arm64'
      : `tmex-gateway-managed-${process.platform}-${process.arch}`
  );
  const artifact = resolve(artifactArg || defaultArtifact);

  if (!existsSync(artifact)) {
    console.error(JSON.stringify({ ok: false, error: 'artifact_missing', artifact }));
    process.exit(1);
  }

  const scan = scanManagedArtifact(artifact);
  if (!scan.ok) {
    console.error(JSON.stringify({ ok: false, error: 'scan_failed', scan }, null, 2));
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'tmex-managed-smoke-'));
  const dbPath = join(work, 'tmex-managed.db');
  const port = freePort();
  const masterKey = '0'.repeat(64);

  // 构造无 bun/node 的 PATH
  const barePath = [join(work, 'bin'), '/usr/bin', '/bin'].join(':');
  mkdirSync(join(work, 'bin'), { recursive: true });

  const env: Record<string, string> = {
    PATH: barePath,
    HOME: work,
    TMPDIR: join(work, 'tmp'),
    NODE_ENV: 'production',
    GATEWAY_PORT: String(port),
    TMEX_BIND_HOST: '127.0.0.1',
    DATABASE_URL: dbPath,
    TMEX_MASTER_KEY: masterKey,
    // 故意注入自管理值，证明 managed entry 在业务模块加载前将其覆盖。
    TMEX_MANAGEMENT_MODE: 'none',
    TMEX_UPDATE_OWNER: 'self',
    // 显式不设 TMEX_FE_DIST_DIR / 生产安装路径
  };
  mkdirSync(env.TMPDIR, { recursive: true });

  // 复制可执行到临时目录，证明不依赖源码树
  const runBin = join(work, 'gateway-managed');
  spawnSync('cp', [artifact, runBin], { stdio: 'inherit' });
  chmodSync(runBin, 0o755);

  // 签名相邻资源：ghostty-vt.wasm 与可执行同目录（loader 回退链）。
  const adjacentWasm = join(resolve(artifact, '..'), 'ghostty-vt.wasm');
  if (existsSync(adjacentWasm)) {
    spawnSync('cp', [adjacentWasm, join(work, 'ghostty-vt.wasm')], { stdio: 'inherit' });
  } else {
    console.error(JSON.stringify({ ok: false, error: 'ghostty_wasm_missing_adjacent', adjacentWasm }));
    process.exit(1);
  }

  const child = spawn(runBin, [], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });

  const report: Record<string, unknown> = {
    ok: false,
    artifact,
    scan,
    work,
    port,
    probes: {} as Record<string, unknown>,
  };

  try {
    const healthy = await waitHealth(port, 30_000);
    (report.probes as Record<string, unknown>).healthz = healthy;
    if (!healthy) {
      report.error = 'health_timeout';
      report.stdout = stdout.slice(-4000);
      report.stderr = stderr.slice(-4000);
      writeFileSync(join(work, 'smoke-report.json'), JSON.stringify(report, null, 2));
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const infoRes = await fetch(`http://127.0.0.1:${port}/api/system/info`);
    const info = (await infoRes.json()) as {
      canSelfUpdate?: boolean;
      managementMode?: string;
      updateOwner?: string;
    };
    (report.probes as Record<string, unknown>).systemInfo = info;

    const updateRes = await fetch(`http://127.0.0.1:${port}/api/system/update-check`);
    const updateBody = await updateRes.json();
    (report.probes as Record<string, unknown>).updateCheck = {
      status: updateRes.status,
      body: updateBody,
    };

    const upgradeRes = await fetch(`http://127.0.0.1:${port}/api/system/upgrade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9' }),
    });
    const upgradeBody = await upgradeRes.json();
    (report.probes as Record<string, unknown>).upgradePost = {
      status: upgradeRes.status,
      body: upgradeBody,
    };

    // 基础 WebSocket 升级探测
    let wsOk = false;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      wsOk = await new Promise<boolean>((resolveWs) => {
        const t = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolveWs(false);
        }, 3000);
        ws.onopen = () => {
          clearTimeout(t);
          ws.close();
          resolveWs(true);
        };
        ws.onerror = () => {
          clearTimeout(t);
          resolveWs(false);
        };
      });
    } catch {
      wsOk = false;
    }
    (report.probes as Record<string, unknown>).websocket = wsOk;

    const managedBlocked =
      info.canSelfUpdate === false &&
      updateRes.status === 403 &&
      (updateBody as { error?: string }).error === 'managed_externally' &&
      upgradeRes.status === 403;

    report.ok = healthy && managedBlocked && infoRes.ok;
    report.managedBlocked = managedBlocked;
    writeFileSync(join(work, 'smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  } finally {
    child.kill('SIGTERM');
    await Bun.sleep(500);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // 保留 work 目录证据时由调用方复制；默认不删以便排障，设置 CLEAN=1 才删
    if (process.env.TMEX_MANAGED_SMOKE_CLEAN === '1') {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  await main();
}
