// 源节点 A 侧的条目展开：目录递归成清单，`relPath` 保留目录结构。
// rsync 的 argv 里没有 `-r`，目录传输只能在这里展开成一个个文件——
// 每文件独立的偏移/校验模型正是断点续传能成立的前提。
// 空目录也要显式登记，否则「传了整棵树」的结果会缺掉没有文件的那些层。

import type { TransferErrorCode, TransferSourceItem } from '@vibeterm/shared';
import { statFile } from '../files/device-storage';
import { normalizeRelPath } from './dest';
import { enumerateTree } from './enumerate';

export const MAX_EXPANDED_FILES = 5000;
/** 访问到的条目总数上限（文件 + 目录），防止「没有文件的深树」绕开文件数上限 */
export const MAX_VISITED_ENTRIES = 20_000;
export const MAX_DEPTH = 32;

export interface ExpandedEntry {
  rootId: string;
  absPath: string;
  relPath: string;
  type: 'file' | 'dir';
  size: number;
  /** 展开阶段就能判定的失败（超限、目标路径撞车等），跑起来直接标记，不必真去读 */
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
}

export type ExpandResult =
  | { ok: true; entries: ExpandedEntry[] }
  | { ok: false; code: TransferErrorCode; detail?: string };

interface Accumulator {
  entries: ExpandedEntry[];
  /** relPath → 已登记条目的下标，用于撞车判定 */
  seen: Map<string, number>;
  files: number;
  visited: number;
}

function markError(entry: ExpandedEntry, opts: ExpandOptions): ExpandedEntry {
  if (entry.type === 'file' && entry.size > opts.maxFileBytes) {
    return { ...entry, error: 'quota_file_size' };
  }
  return entry;
}

/** 两个源文件落到同一个目标相对路径：后来的那个判 `dest_conflict`，不静默覆盖。 */
function push(acc: Accumulator, opts: ExpandOptions, entry: ExpandedEntry): boolean {
  acc.visited += 1;
  if (acc.visited > MAX_VISITED_ENTRIES) return false;
  const rel = normalizeRelPath(entry.relPath);
  if (!rel) return true;
  const prior = acc.seen.get(rel);
  const normalized = { ...markError(entry, opts), relPath: rel };
  if (prior !== undefined) {
    const existing = acc.entries[prior];
    if (existing.type === 'dir' && normalized.type === 'dir') return true;
    acc.entries.push({ ...normalized, error: 'dest_conflict' });
    return true;
  }
  if (normalized.type === 'file') {
    acc.files += 1;
    if (acc.files > MAX_EXPANDED_FILES) return false;
  }
  acc.seen.set(rel, acc.entries.length);
  acc.entries.push(normalized);
  return true;
}

async function expandDirectory(
  item: TransferSourceItem,
  acc: Accumulator,
  opts: ExpandOptions
): Promise<ExpandResult | null> {
  const rootRel = baseName(item.path);
  if (
    !push(acc, opts, {
      rootId: item.rootId,
      absPath: item.path,
      relPath: rootRel,
      type: 'dir',
      size: 0,
    })
  ) {
    return { ok: false, code: 'too_large' };
  }
  const listed = await enumerateTree(item.rootId, item.path, {
    maxEntries: MAX_VISITED_ENTRIES,
    maxDepth: MAX_DEPTH,
  });
  if (!listed.ok)
    return { ok: false, code: listed.code as TransferErrorCode, detail: listed.detail };
  for (const entry of listed.entries) {
    if (opts.signal.aborted) return { ok: false, code: 'cancelled' };
    const ok = push(acc, opts, {
      rootId: item.rootId,
      absPath: entry.absPath,
      relPath: entry.relPath,
      type: entry.type,
      size: entry.size,
    });
    if (!ok) return { ok: false, code: 'too_large' };
  }
  return null;
}

export async function expandItems(
  items: readonly TransferSourceItem[],
  opts: ExpandOptions
): Promise<ExpandResult> {
  const acc: Accumulator = { entries: [], seen: new Map(), files: 0, visited: 0 };
  for (const item of items) {
    if (opts.signal.aborted) return { ok: false, code: 'cancelled' };
    const stat = await statFile(item.rootId, item.path);
    if (!stat.ok) return { ok: false, code: stat.code as TransferErrorCode, detail: stat.detail };
    if (stat.data.type === 'dir') {
      const failed = await expandDirectory(item, acc, opts);
      if (failed) return failed;
      continue;
    }
    const ok = push(acc, opts, {
      rootId: item.rootId,
      absPath: item.path,
      relPath: baseName(item.path),
      type: 'file',
      size: stat.data.size,
    });
    if (!ok) return { ok: false, code: 'too_large' };
  }
  return { ok: true, entries: acc.entries };
}
