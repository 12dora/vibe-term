import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPGRADE_CANCELLED } from '@vibeterm/shared';

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
  // 改名前的资产包名仍是 tmex-cli：向 <2.0.0 的节点推的正是那份，本机也可能解到它。
  if (parsed.name !== 'vibeterm-cli' && parsed.name !== 'tmex-cli') {
    throw new Error(
      `extracted package name is ${String(parsed.name)}, expected vibeterm-cli or tmex-cli`
    );
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

export async function extractCliTarball(
  tarballPath: string,
  stageDir: string,
  signal?: AbortSignal
): Promise<string> {
  await extractTarball(tarballPath, stageDir, signal);
  const packageRoot = join(stageDir, 'package');
  // 改名前的资产只有 bin/tmex.js。
  const binPath = ['vibeterm.js', 'tmex.js']
    .map((name) => join(packageRoot, 'bin', name))
    .find((path) => existsSync(path));
  if (!binPath) {
    throw new Error(`downloaded CLI binary not found in ${join(packageRoot, 'bin')}`);
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
