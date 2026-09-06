// 源节点 A 侧的条目展开：目录递归成文件清单，`relPath` 保留目录结构。
// rsync 的 argv 里没有 `-r`，目录传输只能在这里展开成一个个文件——
// 每文件独立的偏移/校验模型正是断点续传能成立的前提。

import type { TransferErrorCode, TransferSourceItem } from '@tmex/shared';
import { listDirectory, statFile } from '../files/device-storage';

export const MAX_EXPANDED_FILES = 5000;
const MAX_DEPTH = 32;

export interface ExpandedFile {
  rootId: string;
  absPath: string;
  relPath: string;
  size: number;
  /** 展开阶段就能判定的失败（超限等），跑起来直接标记，不必真去读 */
  error?: TransferErrorCode;
}

function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  const base = idx >= 0 ? path.slice(idx + 1) : path;
  return base || path;
}

export interface ExpandOptions {
  maxFileBytes: number;
  signal: AbortSignal;
  onFile?: (file: ExpandedFile) => void;
}

export type ExpandResult =
  | { ok: true; files: ExpandedFile[] }
  | { ok: false; code: TransferErrorCode; detail?: string };

export async function expandItems(
  items: readonly TransferSourceItem[],
  opts: ExpandOptions
): Promise<ExpandResult> {
  const files: ExpandedFile[] = [];
  for (const item of items) {
    if (opts.signal.aborted) return { ok: false, code: 'cancelled' };
    const stat = await statFile(item.rootId, item.path);
    if (!stat.ok) return { ok: false, code: stat.code as TransferErrorCode, detail: stat.detail };
    if (stat.data.type === 'dir') {
      const walked = await walkDirectory(
        item.rootId,
        item.path,
        baseName(item.path),
        files,
        opts,
        0
      );
      if (!walked.ok) return walked;
      continue;
    }
    push(files, opts, {
      rootId: item.rootId,
      absPath: item.path,
      relPath: baseName(item.path),
      size: stat.data.size,
    });
    if (files.length > MAX_EXPANDED_FILES) return { ok: false, code: 'too_large' };
  }
  return { ok: true, files };
}

function push(files: ExpandedFile[], opts: ExpandOptions, file: ExpandedFile): void {
  const marked =
    file.size > opts.maxFileBytes
      ? { ...file, error: 'quota_file_size' as TransferErrorCode }
      : file;
  files.push(marked);
  opts.onFile?.(marked);
}

async function walkDirectory(
  rootId: string,
  dirPath: string,
  relPrefix: string,
  files: ExpandedFile[],
  opts: ExpandOptions,
  depth: number
): Promise<ExpandResult> {
  if (depth > MAX_DEPTH) return { ok: false, code: 'too_large' };
  if (opts.signal.aborted) return { ok: false, code: 'cancelled' };
  const listed = await listDirectory(rootId, dirPath);
  if (!listed.ok)
    return { ok: false, code: listed.code as TransferErrorCode, detail: listed.detail };
  for (const entry of listed.data.entries) {
    if (opts.signal.aborted) return { ok: false, code: 'cancelled' };
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.type === 'dir') {
      const walked = await walkDirectory(rootId, entry.path, rel, files, opts, depth + 1);
      if (!walked.ok) return walked;
      continue;
    }
    if (entry.type !== 'file') continue;
    push(files, opts, {
      rootId,
      absPath: entry.path,
      relPath: rel,
      size: entry.size ?? 0,
    });
    if (files.length > MAX_EXPANDED_FILES) return { ok: false, code: 'too_large' };
  }
  return { ok: true, files };
}
