// 孤儿清扫。半成品的身份是确定性的（作用域 + relPath + 大小），进程重启后新会话能接着传；
// 但没人再来接的那些必须自己清掉，否则用户目录里会长期躺着 `.part-<hash>`，
// ssh 目标的本机暂存目录同理。开机跑一次、之后按周期跑，两处都有硬上限，不做无界遍历。

import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PART_TTL_MS, rangesSidecarPath } from '@tmex/transfer/node';
import { getDeviceById } from '../db';
import { getFileRoots } from '../db/file-roots';
import { activeStagingDirs, isPartClaimed } from './receiver';

/** 只认本模块自己造的名字：`<目标名>.part-<16 位十六进制>`。 */
const PART_NAME = /\.part-[0-9a-f]{16}$/;
const STAGING_NAME = /^tmex-rx-[0-9A-Za-z]{6,32}$/;

const MAX_SWEEP_DIRS = 2000;
const MAX_SWEEP_DEPTH = 6;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SWEEP_START_DELAY_MS = 30_000;

function expired(path: string, now: number, ttlMs: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ttlMs;
  } catch {
    return false;
  }
}

async function sweepDir(dir: string, now: number, ttlMs: number): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!PART_NAME.test(name)) continue;
    const full = join(dir, name);
    if (isPartClaimed(full)) continue;
    if (!expired(full, now, ttlMs)) continue;
    await rm(full, { force: true }).catch(() => {});
    await rm(rangesSidecarPath(full), { force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 本机 root 下的半成品：广度优先，目录数与层级都封顶，不跟符号链接。 */
async function sweepLocalRoots(now: number, ttlMs: number): Promise<number> {
  let visited = 0;
  let removed = 0;
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const root of getFileRoots()) {
    if (!root.enabled) continue;
    const device = getDeviceById(root.deviceId);
    if (device?.type !== 'local') continue;
    // 从 realpath 出发：会话登记的半成品路径也是 realpath，路径写法不一致会漏掉「占用中」的判定
    try {
      queue.push({ dir: realpathSync(root.path), depth: 0 });
    } catch {
      // root 不在了，跳过
    }
  }
  while (queue.length > 0 && visited < MAX_SWEEP_DIRS) {
    const next = queue.shift();
    if (!next) break;
    visited += 1;
    removed += await sweepDir(next.dir, now, ttlMs);
    if (next.depth >= MAX_SWEEP_DEPTH) continue;
    for (const child of subdirectories(next.dir)) {
      if (queue.length + visited >= MAX_SWEEP_DIRS) break;
      queue.push({ dir: child, depth: next.depth + 1 });
    }
  }
  return removed;
}

/** ssh 目标的本机暂存目录：整目录按 TTL 回收，正在被会话使用的跳过。 */
function sweepStagingDirs(now: number, ttlMs: number): number {
  const live = activeStagingDirs();
  const base = tmpdir();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!STAGING_NAME.test(name)) continue;
    const full = join(base, name);
    if (live.has(full)) continue;
    if (!expired(full, now, ttlMs)) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

export async function sweepTransferOrphans(
  now = Date.now(),
  ttlMs = PART_TTL_MS
): Promise<{ parts: number; stagingDirs: number }> {
  const parts = await sweepLocalRoots(now, ttlMs);
  const stagingDirs = sweepStagingDirs(now, ttlMs);
  return { parts, stagingDirs };
}

function schedule(): void {
  if (process.env.NODE_ENV === 'test') return;
  const boot = setTimeout(() => void sweepTransferOrphans().catch(() => {}), SWEEP_START_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(() => void sweepTransferOrphans().catch(() => {}), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

schedule();
