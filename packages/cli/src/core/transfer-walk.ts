// 递归枚举：本地用 node:fs，远端用 GET /api/files/list（每层最多 2000 条，截断记到 truncated）。

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listDirectory } from './files-api';
import { posixJoin } from './files-path';
import type { HttpClient } from './http';

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

export async function walkLocal(root: string): Promise<LocalWalkEntry[]> {
  const out: LocalWalkEntry[] = [];
  await walkLocalDir(root, '', out);
  return out;
}

async function walkLocalDir(root: string, rel: string, out: LocalWalkEntry[]): Promise<void> {
  const abs = rel ? join(root, rel) : root;
  const entries = await readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push({ abs: childAbs, rel: childRel, size: 0, dir: true });
      await walkLocalDir(root, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(childAbs);
    out.push({ abs: childAbs, rel: childRel, size: info.size, dir: false });
  }
}

export async function walkRemote(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  absPath: string
): Promise<{ entries: RemoteWalkEntry[]; truncated: boolean }> {
  const entries: RemoteWalkEntry[] = [];
  const truncated = await walkRemoteDir(http, nodeId, rootId, absPath, '', entries);
  return { entries, truncated };
}

async function walkRemoteDir(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  base: string,
  rel: string,
  out: RemoteWalkEntry[]
): Promise<boolean> {
  const abs = rel ? posixJoin(base, rel) : base;
  const listing = await listDirectory(http, nodeId, rootId, abs);
  let truncated = listing.truncated;
  for (const entry of listing.entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.type === 'dir') {
      out.push({ abs: entry.path, rel: childRel, size: 0, dir: true });
      truncated = (await walkRemoteDir(http, nodeId, rootId, base, childRel, out)) || truncated;
      continue;
    }
    out.push({
      abs: entry.path,
      rel: childRel,
      size: entry.size ?? 0,
      dir: false,
    });
  }
  return truncated;
}
