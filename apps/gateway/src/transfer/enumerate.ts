// 源侧的完整目录枚举。浏览用的 `listDirectory` 会在 2000 条截断并只报一个 `truncated` 标志，
// 传输不能吃这种截断（少传的文件不会有人发现），所以这里改用一次递归 `rsync --list-only`：
// 一趟拿到整棵树（相对路径 + 类型 + 大小），条目数超过硬上限就整体失败，绝不静默少传。

import type { FileErrorCode } from '@tmex/shared';
import { getDeviceById } from '../db';
import { checkAndNormalize } from '../files/device-storage';
import { resolveFileRoot } from '../files/file-root';
import { classifyRsyncFailure, createListOnlyCollector, runRsync } from '../files/rsync';
import { withDeviceRsync } from '../files/rsync-operation';
import { type RsyncDeviceSpec, rsyncTargetArg } from '../files/ssh-command';
import { parentOf } from './dest';

const ENUMERATE_TIMEOUT_MS = 60_000;

export interface EnumeratedEntry {
  relPath: string;
  absPath: string;
  type: 'file' | 'dir';
  size: number;
}

export type EnumerateResult =
  | { ok: true; entries: EnumeratedEntry[] }
  | { ok: false; code: FileErrorCode; detail?: string };

function listArgs(spec: RsyncDeviceSpec, dirPath: string): string[] {
  // 不带结尾斜杠：条目名天然带上目录 basename 前缀，正好就是 relPath
  const args = ['--list-only', '-r', '--8-bit-output'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, dirPath));
  return args;
}

function depthOf(relPath: string): number {
  let depth = 0;
  for (const ch of relPath) if (ch === '/') depth += 1;
  return depth;
}

/**
 * 枚举一棵目录树。`maxEntries` 是「访问到的条目总数」上限（含目录与被跳过的符号链接），
 * `maxDepth` 限制层级；两者任一触顶都返回 `too_large`。
 */
export async function enumerateTree(
  rootId: string,
  dirPath: string,
  opts: { maxEntries: number; maxDepth: number }
): Promise<EnumerateResult> {
  const resolved = resolveFileRoot(rootId);
  if (!resolved.ok) return { ok: false, code: resolved.code };
  const root = resolved.root;
  const device = getDeviceById(root.deviceId);
  if (!device) return { ok: false, code: 'device_not_found' };
  const norm = checkAndNormalize(device, root.path, dirPath);
  if (!norm.ok) return { ok: false, code: norm.code };

  const base = parentOf(norm.path);
  const result = await withDeviceRsync(device, async (spec) => {
    const collector = createListOnlyCollector(opts.maxEntries);
    const res = await runRsync(listArgs(spec, norm.path), {
      env: spec.env,
      timeoutMs: ENUMERATE_TIMEOUT_MS,
      onStdoutLine: (line) => collector.accept(line),
    });
    if (res.exitCode !== 0) {
      return { ok: false as const, code: classifyRsyncFailure(res.exitCode, res.stderr) };
    }
    const snapshot = collector.snapshot();
    if (snapshot.truncated) return { ok: false as const, code: 'too_large' as FileErrorCode };
    const entries: EnumeratedEntry[] = [];
    for (const entry of snapshot.entries) {
      if (entry.type !== 'dir' && entry.type !== 'file') continue;
      if (depthOf(entry.name) > opts.maxDepth) {
        return { ok: false as const, code: 'too_large' as FileErrorCode };
      }
      entries.push({
        relPath: entry.name,
        absPath: base === '/' ? `/${entry.name}` : `${base}/${entry.name}`,
        type: entry.type,
        size: entry.type === 'dir' ? 0 : (entry.size ?? 0),
      });
    }
    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { ok: true as const, data: entries };
  });
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
  return { ok: true, entries: result.data };
}
