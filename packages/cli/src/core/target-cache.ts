// 目标缓存：`<configDir>/targets.json`（0600）。记住「目标写法 → node」的解析结果，
// 省掉每次 exec / rsh 前的 `GET /api/mesh/nodes`；缓存只是加速，任何读写失败都当作未命中。

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TARGETS_FILE_NAME = 'targets.json';
export const TARGET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type CachedTarget = { nodeId: string; name: string };
type CacheRow = CachedTarget & { at: number };
type CacheFile = { v: 1; entries: Record<string, Record<string, CacheRow>> };

const NODE_KEY_PREFIX = 'node:';
const BARE_KEY_PREFIX = 'bare:';

/** `<node>/<device>` 里的 node 写法。 */
export function nodeKey(ref: string): string {
  return `${NODE_KEY_PREFIX}${ref}`;
}

/** 只写了一段的目标：先当入口上的设备失败、再当 node 解析成功时记下。 */
export function bareKey(token: string): string {
  return `${BARE_KEY_PREFIX}${token}`;
}

function isRow(value: unknown): value is CacheRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.nodeId === 'string' && typeof row.name === 'string' && typeof row.at === 'number'
  );
}

function parseFile(raw: string): CacheFile {
  const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown };
  const entries: CacheFile['entries'] = {};
  if (parsed.v !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
    return { v: 1, entries };
  }
  for (const [entry, rows] of Object.entries(parsed.entries as Record<string, unknown>)) {
    if (!rows || typeof rows !== 'object') continue;
    const kept: Record<string, CacheRow> = {};
    for (const [key, row] of Object.entries(rows as Record<string, unknown>)) {
      if (isRow(row)) kept[key] = row;
    }
    entries[entry] = kept;
  }
  return { v: 1, entries };
}

export class TargetCache {
  private data: CacheFile | null = null;

  constructor(
    readonly path: string,
    private readonly entry: string,
    private readonly now: () => number = Date.now
  ) {}

  static open(configDir: string, entry: string, now?: () => number): TargetCache {
    return new TargetCache(join(configDir, TARGETS_FILE_NAME), entry, now);
  }

  get(key: string): CachedTarget | null {
    const row = this.load().entries[this.entry]?.[key];
    if (!row || this.now() - row.at >= TARGET_CACHE_TTL_MS || row.at > this.now()) return null;
    return { nodeId: row.nodeId, name: row.name };
  }

  set(key: string, target: CachedTarget): void {
    const file = this.load();
    const rows = file.entries[this.entry] ?? {};
    file.entries[this.entry] = rows;
    rows[key] = { ...target, at: this.now() };
    this.save(file);
  }

  drop(key: string): void {
    const file = this.load();
    const rows = file.entries[this.entry];
    if (!rows || !(key in rows)) return;
    delete rows[key];
    this.save(file);
  }

  private load(): CacheFile {
    if (this.data) return this.data;
    try {
      this.data = parseFile(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = { v: 1, entries: {} };
    }
    return this.data;
  }

  private prune(file: CacheFile): void {
    const limit = this.now() - TARGET_CACHE_TTL_MS;
    for (const [entry, rows] of Object.entries(file.entries)) {
      for (const [key, row] of Object.entries(rows)) {
        if (row.at <= limit) delete rows[key];
      }
      if (Object.keys(rows).length === 0) delete file.entries[entry];
    }
  }

  /** 原子写：同目录临时文件（0600）再 rename；失败静默。 */
  private save(file: CacheFile): void {
    this.prune(file);
    const tmp = `${this.path}.${process.pid}.${this.now()}.tmp`;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch {
      removeQuietly(tmp);
    }
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 目录不可达时临时文件本就不存在
  }
}
