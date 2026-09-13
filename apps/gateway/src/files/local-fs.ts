// 本机设备的文件读写走 node:fs，不 spawn rsync。SSH 设备仍走 rsync.ts。

import {
  type Stats,
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type {
  FileContentResponse,
  FileEntryDto,
  FileEntryType,
  FileStatResponse,
  ListFilesResponse,
} from '@vibeterm/shared';
import { MAX_ENTRIES, MAX_TEXT_BYTES, categorize, mimeOf } from './categorize';
import { type RsyncProgress, compareListEntry } from './rsync';
import { type FileOpResult, fail, ok } from './rsync-operation';

export interface LocalPushOptions {
  onProgress?: (p: RsyncProgress) => void;
  signal?: AbortSignal;
}

function errnoOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err)
    return String((err as { code: unknown }).code);
  return '';
}

export function mapFsError(err: unknown): FileOpResult<never> {
  const code = errnoOf(err);
  if (code === 'ENOENT') return fail('not_found');
  if (code === 'ENOTDIR') return fail('not_a_directory');
  if (code === 'EISDIR') return fail('is_directory');
  if (code === 'EACCES' || code === 'EPERM') return fail('permission_denied');
  if (code === 'ETIMEDOUT') return fail('timeout');
  if (code === 'ENAMETOOLONG') return fail('invalid');
  return fail('unknown');
}

export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function posixBasename(p: string): string {
  const i = p.lastIndexOf('/');
  const base = i >= 0 ? p.slice(i + 1) : p;
  return base || p;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoLocal(mtime: Date): string {
  const day = `${mtime.getFullYear()}-${pad2(mtime.getMonth() + 1)}-${pad2(mtime.getDate())}`;
  const time = `${pad2(mtime.getHours())}:${pad2(mtime.getMinutes())}:${pad2(mtime.getSeconds())}`;
  return `${day}T${time}`;
}

function typeOfLstat(st: Stats): FileEntryType {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function collectLocalEntries(absPath: string): FileEntryDto[] {
  const dirents = readdirSync(absPath, { withFileTypes: true });
  const entries: FileEntryDto[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (name === '.' || name === '..') continue;
    const child = posixJoin(absPath, name);
    const st = tryLstat(child);
    if (!st) continue;
    const type = typeOfLstat(st);
    entries.push({
      name,
      path: child,
      type,
      category: type === 'dir' ? 'directory' : categorize(name),
      size: type === 'dir' ? null : st.size,
      modifiedAt: isoLocal(st.mtime),
      isSymlink: type === 'symlink',
    });
  }
  return entries;
}

export function listLocalDirectory(absPath: string): FileOpResult<ListFilesResponse> {
  try {
    const st = statSync(absPath);
    if (!st.isDirectory()) return fail('not_a_directory');
    const entries = collectLocalEntries(absPath);
    entries.sort(compareListEntry);
    const truncated = entries.length > MAX_ENTRIES;
    return ok({
      path: absPath,
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
    });
  } catch (err) {
    return mapFsError(err);
  }
}

export function statLocalPath(absPath: string): FileOpResult<FileStatResponse> {
  try {
    const lst = lstatSync(absPath);
    const type = typeOfLstat(lst);
    const name = posixBasename(absPath);
    const isDir = type === 'dir';
    return ok({
      path: absPath,
      name,
      type,
      category: isDir ? 'directory' : categorize(name),
      size: isDir ? 0 : lst.size,
      modifiedAt: isoLocal(lst.mtime),
      mime: isDir ? null : mimeOf(name),
      isSymlink: type === 'symlink',
    });
  } catch (err) {
    return mapFsError(err);
  }
}

function followSize(absPath: string, lst: Stats): FileOpResult<number> {
  if (lst.isDirectory()) return fail('is_directory');
  if (!lst.isSymbolicLink()) return ok(lst.size);
  try {
    const followed = statSync(absPath);
    if (followed.isDirectory()) return fail('is_directory');
    return ok(followed.size);
  } catch (err) {
    return mapFsError(err);
  }
}

export function readLocalTextFile(absPath: string): FileOpResult<FileContentResponse> {
  try {
    const lst = lstatSync(absPath);
    const sized = followSize(absPath, lst);
    if (!sized.ok) return sized;
    if (sized.data > MAX_TEXT_BYTES) return fail('too_large');
    const buf = readFileSync(absPath);
    if (buf.length > MAX_TEXT_BYTES) return fail('too_large');
    if (looksBinary(buf)) return fail('binary');
    const name = posixBasename(absPath);
    return ok({
      path: absPath,
      name,
      category: categorize(name),
      encoding: 'utf-8',
      content: buf.toString('utf-8'),
      size: sized.data,
      truncated: false,
    });
  } catch (err) {
    return mapFsError(err);
  }
}

export interface LocalFileHandle {
  tmpPath: string;
  size: number;
  name: string;
  mime: string | null;
  cleanup: () => void;
}

export function localFileHandle(absPath: string, maxBytes: number): FileOpResult<LocalFileHandle> {
  try {
    const st = statSync(absPath);
    if (st.isDirectory()) return fail('is_directory');
    if (st.size > maxBytes) return fail('too_large', String(maxBytes));
    const name = posixBasename(absPath);
    return ok({ tmpPath: absPath, size: st.size, name, mime: mimeOf(name), cleanup: () => {} });
  } catch (err) {
    return mapFsError(err);
  }
}

function rateString(bytes: number, ms: number): string {
  if (ms <= 0) return '0B/s';
  const bps = bytes / (ms / 1000);
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)}MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(2)}KB/s`;
  return `${Math.round(bps)}B/s`;
}

export const localFsIo = {
  copyFile: copyFileSync,
};

function destDirOk(destDir: string): FileOpResult<void> {
  try {
    if (!statSync(destDir).isDirectory()) return fail('not_a_directory');
    return ok(undefined);
  } catch (err) {
    return mapFsError(err);
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // temp may not exist
  }
}

function putTempPath(destDir: string, name: string): string {
  const rand = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  return posixJoin(destDir, `.${name}.vibeterm-put-${rand}`);
}

function commitPut(tmp: string, dest: string): FileOpResult<void> {
  const st = tryLstat(dest);
  if (st?.isDirectory()) return fail('not_a_directory');
  if (st?.isSymbolicLink()) {
    try {
      unlinkSync(dest);
    } catch (err) {
      return mapFsError(err);
    }
  }
  try {
    renameSync(tmp, dest);
    return ok(undefined);
  } catch (err) {
    return mapFsError(err);
  }
}

export function pushLocalFile(
  destDir: string,
  srcPath: string,
  name: string,
  opts: LocalPushOptions = {}
): FileOpResult<{ uploaded: string }> {
  if (opts.signal?.aborted) return fail('unknown');
  const dir = destDirOk(destDir);
  if (!dir.ok) return dir;
  const dest = posixJoin(destDir, name);
  const tmp = putTempPath(destDir, name);
  const started = Date.now();
  try {
    localFsIo.copyFile(srcPath, tmp);
  } catch (err) {
    unlinkQuiet(tmp);
    return mapFsError(err);
  }
  const committed = commitPut(tmp, dest);
  if (!committed.ok) {
    unlinkQuiet(tmp);
    return committed;
  }
  let size = 0;
  try {
    size = statSync(dest).size;
  } catch {
    size = 0;
  }
  opts.onProgress?.({
    transferred: size,
    pct: 100,
    rate: rateString(size, Date.now() - started),
  });
  return ok({ uploaded: name });
}
