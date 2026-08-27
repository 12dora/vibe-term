import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Device,
  FileContentResponse,
  FileEntryDto,
  FileErrorCode,
  FileStatResponse,
  ListFilesResponse,
} from '@tmex/shared';
import { config } from '../config';
import { getDeviceById } from '../db';
import { type FileRootRecord, getFileRootById } from '../db/file-roots';
import { MAX_ENTRIES, MAX_TEXT_BYTES, categorize, mimeOf } from './categorize';
import {
  type RsyncEntry,
  RsyncMissingLocalError,
  type RsyncProgress,
  classifyRsyncFailure,
  parseListOnly,
  runRsync,
} from './rsync';
import { type FileOpResult, fail, ok, withDeviceRsync } from './rsync-operation';
import { type RsyncDeviceSpec, rsyncCopyArgs, rsyncListArgs, rsyncUploadArgs } from './ssh-command';

export type { FileOpResult };

const RAW_MAX_BYTES = 50 * 1024 * 1024;
const LIST_TIMEOUT_MS = 20_000;
const COPY_TIMEOUT_MS = 60_000;
// 传输（上传推送 / 下载拉取）空闲超时：有进度即重置，故对慢速大文件友好
const TRANSFER_IDLE_TIMEOUT_MS = 120_000;

// ---- posix 路径工具（gateway 仅运行于 unix） ----
function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}
function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}
function posixBasename(p: string): string {
  const i = p.lastIndexOf('/');
  const base = i >= 0 ? p.slice(i + 1) : p;
  return base || p;
}

// 路径安全：必须落在 root 内。local 设备额外 realpath 防符号链接逃逸。导出以便单测。
export function checkAndNormalize(
  device: Device,
  rootPath: string,
  inputPath: string
): { ok: true; path: string } | { ok: false; code: FileErrorCode } {
  if (!inputPath || !inputPath.startsWith('/')) return { ok: false, code: 'invalid' };
  const normRoot = posixNormalize(rootPath);
  const normPath = posixNormalize(inputPath);
  const prefix = normRoot === '/' ? '/' : `${normRoot}/`;
  if (!(normPath === normRoot || normPath.startsWith(prefix))) {
    return { ok: false, code: 'outside_roots' };
  }

  if (device.type === 'local') {
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(normRoot);
    } catch {
      return { ok: false, code: 'root_not_found' };
    }
    try {
      realTarget = realpathSync(normPath);
    } catch {
      return { ok: false, code: 'not_found' };
    }
    const rPrefix = realRoot === '/' ? '/' : `${realRoot}/`;
    if (!(realTarget === realRoot || realTarget.startsWith(rPrefix))) {
      return { ok: false, code: 'outside_roots' };
    }
  }

  return { ok: true, path: normPath };
}

interface OpContext {
  root: FileRootRecord;
  device: Device;
}

function resolveContext(
  rootId: string
): { ok: true; ctx: OpContext } | { ok: false; code: FileErrorCode } {
  const root = getFileRootById(rootId);
  if (!root) return { ok: false, code: 'root_not_found' };
  if (!root.enabled) return { ok: false, code: 'root_disabled' };
  const device = getDeviceById(root.deviceId);
  if (!device) return { ok: false, code: 'device_not_found' };
  return { ok: true, ctx: { root, device } };
}

function entryToDto(entry: RsyncEntry, parentPath: string): FileEntryDto {
  return {
    name: entry.name,
    path: posixJoin(parentPath, entry.name),
    type: entry.type,
    category: entry.type === 'dir' ? 'directory' : categorize(entry.name),
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    isSymlink: entry.type === 'symlink',
  };
}

function sortEntries(entries: FileEntryDto[]): void {
  entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function withNormalizedRsync<T>(
  rootId: string,
  inputPath: string | null,
  fn: (ctx: { spec: RsyncDeviceSpec; path: string }) => Promise<FileOpResult<T>>
): Promise<FileOpResult<T>> {
  const r = resolveContext(rootId);
  if (!r.ok) return fail(r.code);
  const { root, device } = r.ctx;
  const norm = checkAndNormalize(device, root.path, inputPath ?? root.path);
  if (!norm.ok) return fail(norm.code);
  return withDeviceRsync(device, (spec) => fn({ spec, path: norm.path }));
}

export async function listDirectory(
  rootId: string,
  inputPath: string | null
): Promise<FileOpResult<ListFilesResponse>> {
  return withNormalizedRsync(rootId, inputPath, async ({ spec, path }) => {
    const listPath = path.endsWith('/') ? path : `${path}/`;
    let res: Awaited<ReturnType<typeof runRsync>>;
    try {
      res = await runRsync(rsyncListArgs(spec, listPath), {
        env: spec.env,
        timeoutMs: LIST_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
      throw error;
    }
    if (res.exitCode !== 0) return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);

    const parsed = parseListOnly(res.stdout);
    const truncated = parsed.length > MAX_ENTRIES;
    const slice = truncated ? parsed.slice(0, MAX_ENTRIES) : parsed;
    const entries = slice.map((e) => entryToDto(e, path));
    sortEntries(entries);
    return ok({ path, entries, truncated });
  });
}

async function statViaRsync(
  spec: RsyncDeviceSpec,
  normPath: string
): Promise<FileOpResult<RsyncEntry>> {
  let res: Awaited<ReturnType<typeof runRsync>>;
  try {
    res = await runRsync(rsyncListArgs(spec, normPath), {
      env: spec.env,
      timeoutMs: LIST_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
    throw error;
  }
  if (res.exitCode !== 0) return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);
  const entry = parseListOnly(res.stdout)[0];
  if (!entry) return fail('not_found');
  return ok(entry);
}

export async function statFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<FileStatResponse>> {
  return withNormalizedRsync(rootId, inputPath, async ({ spec, path }) => {
    const st = await statViaRsync(spec, path);
    if (!st.ok) return st;
    const name = posixBasename(path);
    const isDir = st.data.type === 'dir';
    const type = isDir ? 'dir' : st.data.type === 'symlink' ? 'symlink' : 'file';
    return ok<FileStatResponse>({
      path,
      name,
      type,
      category: isDir ? 'directory' : categorize(name),
      size: isDir ? 0 : (st.data.size ?? 0),
      modifiedAt: st.data.modifiedAt,
      mime: isDir ? null : mimeOf(name),
      isSymlink: st.data.type === 'symlink',
    });
  });
}

async function copyToBuffer(
  spec: RsyncDeviceSpec,
  normPath: string
): Promise<FileOpResult<Buffer>> {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-rfile-'));
  const dest = join(dir, 'f');
  try {
    let res: Awaited<ReturnType<typeof runRsync>>;
    try {
      res = await runRsync(rsyncCopyArgs(spec, normPath, dest), {
        env: spec.env,
        timeoutMs: COPY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
      throw error;
    }
    if (res.exitCode !== 0) return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);
    return ok(readFileSync(dest));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export async function readTextFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<FileContentResponse>> {
  return withNormalizedRsync(rootId, inputPath, async ({ spec, path }) => {
    const st = await statViaRsync(spec, path);
    if (!st.ok) return st;
    if (st.data.type === 'dir') return fail('is_directory');
    if (st.data.size != null && st.data.size > MAX_TEXT_BYTES) return fail('too_large');

    const buf = await copyToBuffer(spec, path);
    if (!buf.ok) return buf;
    if (buf.data.length > MAX_TEXT_BYTES) return fail('too_large');
    if (looksBinary(buf.data)) return fail('binary');

    const name = posixBasename(path);
    return ok<FileContentResponse>({
      path,
      name,
      category: categorize(name),
      encoding: 'utf-8',
      content: buf.data.toString('utf-8'),
      size: st.data.size ?? buf.data.length,
      truncated: false,
    });
  });
}

export interface RawFileData {
  data: Uint8Array<ArrayBuffer>;
  name: string;
  mime: string | null;
}

export async function readRawFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<RawFileData>> {
  return withNormalizedRsync(rootId, inputPath, async ({ spec, path }) => {
    const st = await statViaRsync(spec, path);
    if (!st.ok) return st;
    if (st.data.type === 'dir') return fail('is_directory');
    if (st.data.size != null && st.data.size > RAW_MAX_BYTES) return fail('too_large');

    const buf = await copyToBuffer(spec, path);
    if (!buf.ok) return buf;
    if (buf.data.length > RAW_MAX_BYTES) return fail('too_large');

    const name = posixBasename(path);
    return ok<RawFileData>({ data: new Uint8Array(buf.data), name, mime: mimeOf(name) });
  });
}

// 上传文件名消毒：只取最后一段，拒绝空 / . / .. / 含分隔符或 NUL，防路径穿越。
// 独立于 posixBasename（后者不拒绝 ..，语义不同）。导出以便单测。
export function sanitizeUploadName(raw: string): string | null {
  const base = raw.split('/').pop() ?? '';
  if (base === '' || base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return null;
  return base;
}

export interface TransferOptions {
  onProgress?: (p: RsyncProgress) => void;
  signal?: AbortSignal;
}

// 把本机已落盘的临时文件 srcPath 推送到设备 destDir/name（反向 rsync）。
// destDir 必须落在 root 内且为已存在目录；name 调用方应已消毒（这里再次兜底）。
export async function pushFileToDevice(
  rootId: string,
  destDir: string,
  srcPath: string,
  name: string,
  opts: TransferOptions = {}
): Promise<FileOpResult<{ uploaded: string }>> {
  const safeName = sanitizeUploadName(name);
  if (!safeName) return fail('invalid');
  // 目标文件尚不存在，只能校验已存在的 destDir（local 分支 realpathSync 防符号链接逃逸）。
  return withNormalizedRsync(rootId, destDir, async ({ spec, path }) => {
    const destStat = await statViaRsync(spec, path);
    if (!destStat.ok) return destStat;
    if (destStat.data.type !== 'dir') return fail('not_a_directory');

    const remoteDest = posixJoin(path, safeName);
    let res: Awaited<ReturnType<typeof runRsync>>;
    try {
      res = await runRsync(rsyncUploadArgs(spec, srcPath, remoteDest), {
        env: spec.env,
        onProgress: opts.onProgress,
        idleTimeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
        signal: opts.signal,
      });
    } catch (error) {
      if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
      throw error;
    }
    if (res.exitCode !== 0) return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);
    return ok({ uploaded: safeName });
  });
}

export interface PulledFile {
  /** 本机临时文件路径，调用方流式读取后须调用 cleanup */
  tmpPath: string;
  size: number;
  name: string;
  mime: string | null;
  cleanup: () => void;
}

// 把设备上的文件拉到本机临时文件（正向 rsync），供 HTTP 流式下载。校验大小 ≤ 配置上限。
export async function pullFileFromDevice(
  rootId: string,
  inputPath: string,
  opts: TransferOptions = {}
): Promise<FileOpResult<PulledFile>> {
  return withNormalizedRsync(rootId, inputPath, async ({ spec, path }) => {
    const st = await statViaRsync(spec, path);
    if (!st.ok) return st;
    if (st.data.type === 'dir') return fail('is_directory');
    if (st.data.size != null && st.data.size > config.transferMaxBytes) return fail('too_large');

    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const dest = join(dir, 'f');
    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
    let res: Awaited<ReturnType<typeof runRsync>>;
    try {
      res = await runRsync(rsyncCopyArgs(spec, path, dest), {
        env: spec.env,
        onProgress: opts.onProgress,
        idleTimeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
        signal: opts.signal,
      });
    } catch (error) {
      cleanup();
      if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
      throw error;
    }
    if (res.exitCode !== 0) {
      cleanup();
      return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);
    }
    const name = posixBasename(path);
    let size = st.data.size ?? 0;
    try {
      size = statSync(dest).size;
    } catch {
      // 退回 stat 大小
    }
    if (size > config.transferMaxBytes) {
      cleanup();
      return fail('too_large');
    }
    return ok<PulledFile>({ tmpPath: dest, size, name, mime: mimeOf(name), cleanup });
  });
}
