// 递归枚举：本地用 node:fs，远端用 GET /api/files/list（每层最多 2000 条，截断记到 truncated）。
// 符号链接与（mkdir 不可用时的）空目录不进 entries，记到 skipped。

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listDirectory } from './files-api';
import { posixJoin } from './files-path';
import type { HttpClient } from './http';

export type WalkSkipReason = 'symlink' | 'empty-dir';

export interface WalkSkip {
  rel: string;
  reason: WalkSkipReason;
}

export interface LocalWalkEntry {
  abs: string;
  rel: string;
  size: number;
  dir: boolean;
}

export interface RemoteWalkEntry {
  abs: string;
  rel: string;
  size: number;
  dir: boolean;
}

export interface LocalWalkResult {
  entries: LocalWalkEntry[];
  skipped: WalkSkip[];
}

export interface RemoteWalkResult {
  entries: RemoteWalkEntry[];
  skipped: WalkSkip[];
  truncated: boolean;
}

export async function walkLocal(root: string): Promise<LocalWalkResult> {
  const entries: LocalWalkEntry[] = [];
  const skipped: WalkSkip[] = [];
  await walkLocalDir(root, '', entries, skipped);
  return { entries, skipped };
}

async function walkLocalDir(
  root: string,
  rel: string,
  out: LocalWalkEntry[],
  skipped: WalkSkip[]
): Promise<void> {
  const abs = rel ? join(root, rel) : root;
  const children = await readdir(abs, { withFileTypes: true });
  for (const entry of children) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = join(abs, entry.name);
    if (entry.isSymbolicLink()) {
      skipped.push({ rel: childRel, reason: 'symlink' });
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ abs: childAbs, rel: childRel, size: 0, dir: true });
      await walkLocalDir(root, childRel, out, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(childAbs);
    out.push({ abs: childAbs, rel: childRel, size: info.size, dir: false });
  }
}

export function emptyDirRels(entries: ReadonlyArray<{ rel: string; dir: boolean }>): string[] {
  const files = entries.filter((entry) => !entry.dir);
  return entries
    .filter((entry) => entry.dir)
    .filter(
      (dir) => !files.some((file) => file.rel === dir.rel || file.rel.startsWith(`${dir.rel}/`))
    )
    .map((dir) => dir.rel);
}

export async function walkRemote(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  absPath: string
): Promise<RemoteWalkResult> {
  const entries: RemoteWalkEntry[] = [];
  const skipped: WalkSkip[] = [];
  const truncated = await walkRemoteDir(http, nodeId, rootId, absPath, '', entries, skipped);
  return { entries, skipped, truncated };
}

async function walkRemoteDir(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  base: string,
  rel: string,
  out: RemoteWalkEntry[],
  skipped: WalkSkip[]
): Promise<boolean> {
  const abs = rel ? posixJoin(base, rel) : base;
  const listing = await listDirectory(http, nodeId, rootId, abs);
  let truncated = listing.truncated;
  for (const entry of listing.entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.type === 'symlink' || entry.isSymlink) {
      skipped.push({ rel: childRel, reason: 'symlink' });
      continue;
    }
    if (entry.type === 'dir') {
      out.push({ abs: entry.path, rel: childRel, size: 0, dir: true });
      truncated =
        (await walkRemoteDir(http, nodeId, rootId, base, childRel, out, skipped)) || truncated;
      continue;
    }
    if (entry.type !== 'file') continue;
    out.push({
      abs: entry.path,
      rel: childRel,
      size: entry.size ?? 0,
      dir: false,
    });
  }
  return truncated;
}
