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
} from '@vibeterm/shared';
import { config } from '../config';
import { getDeviceById } from '../db';
import type { FileRootRecord } from '../db/file-roots';
import { MAX_ENTRIES, MAX_TEXT_BYTES, categorize, mimeOf } from './categorize';
import { resolveFileRoot } from './file-root';
import {
  type LocalFileHandle,
  listLocalDirectory,
  localFileHandle,
  looksBinary,
  pushLocalFile,
  readLocalTextFile,
  statLocalPath,
} from './local-fs';
import { enqueueDeviceJob } from './queue';
import {
  type RsyncEntry,
  RsyncMissingLocalError,
  type RsyncProgress,
  type RsyncResult,
  classifyRsyncFailure,
  createListOnlyCollector,
  parseListOnly,
  runRsync,
} from './rsync';
import { type FileOpResult, fail, ok, withDeviceRsync } from './rsync-operation';
import { type RsyncDeviceSpec, rsyncCopyArgs, rsyncListArgs, rsyncUploadArgs } from './ssh-command';
import { transferMaxBytesNow } from './transfer-limit';

export type { FileOpResult };

const RAW_MAX_BYTES = 50 * 1024 * 1024;
const LIST_TIMEOUT_MS = 20_000;
const COPY_TIMEOUT_MS = 60_000;
const TRANSFER_IDLE_TIMEOUT_MS = 120_000;

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
  const resolved = resolveFileRoot(rootId);
  if (!resolved.ok) return { ok: false, code: resolved.code };
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return { ok: false, code: 'device_not_found' };
  return { ok: true, ctx: { root: resolved.root, device } };
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

async function withNormalized<T>(
  rootId: string,
  inputPath: string | null,
  fn: (ctx: { path: string; device: Device }) => Promise<FileOpResult<T>>
): Promise<FileOpResult<T>> {
  const r = resolveContext(rootId);
  if (!r.ok) return fail(r.code);
  const { root, device } = r.ctx;
  const norm = checkAndNormalize(device, root.path, inputPath ?? root.path);
  if (!norm.ok) return fail(norm.code);
  return fn({ path: norm.path, device });
}

async function runRsyncOrMissing(
  run: () => Promise<RsyncResult>,
  cleanup?: () => void
): Promise<FileOpResult<RsyncResult>> {
  try {
    return ok(await run());
  } catch (error) {
    cleanup?.();
    if (error instanceof RsyncMissingLocalError) return fail('rsync_missing_local');
    throw error;
  }
}

function rsyncFail(exitCode: number, stderr: string, cleanup?: () => void): FileOpResult<never> {
  cleanup?.();
  return fail(classifyRsyncFailure(exitCode, stderr), stderr);
}

async function listRemoteDirectory(
  spec: RsyncDeviceSpec,
  path: string
): Promise<FileOpResult<ListFilesResponse>> {
  const listPath = path.endsWith('/') ? path : `${path}/`;
  const collector = createListOnlyCollector(MAX_ENTRIES);
  const res = await runRsyncOrMissing(() =>
    runRsync(rsyncListArgs(spec, listPath), {
      env: spec.env,
      timeoutMs: LIST_TIMEOUT_MS,
      onStdoutLine: (line) => collector.accept(line),
    })
  );
  if (!res.ok) return res;
  if (res.data.exitCode !== 0) return rsyncFail(res.data.exitCode, res.data.stderr);
  const parsed = collector.snapshot();
  return ok({
    path,
    entries: parsed.entries.map((e) => entryToDto(e, path)),
    truncated: parsed.truncated,
  });
}

export async function listDirectory(
  rootId: string,
  inputPath: string | null
): Promise<FileOpResult<ListFilesResponse>> {
  return withNormalized(rootId, inputPath, async ({ path, device }) => {
    if (device.type === 'local') return listLocalDirectory(path);
    return withDeviceRsync(device, (spec) => listRemoteDirectory(spec, path));
  });
}

async function statViaRsync(
  spec: RsyncDeviceSpec,
  normPath: string
): Promise<FileOpResult<RsyncEntry>> {
  const res = await runRsyncOrMissing(() =>
    runRsync(rsyncListArgs(spec, normPath), {
      env: spec.env,
      timeoutMs: LIST_TIMEOUT_MS,
    })
  );
  if (!res.ok) return res;
  if (res.data.exitCode !== 0) return rsyncFail(res.data.exitCode, res.data.stderr);
  const entry = parseListOnly(res.data.stdout)[0];
  if (!entry) return fail('not_found');
  return ok(entry);
}

export async function statFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<FileStatResponse>> {
  return withNormalized(rootId, inputPath, async ({ path, device }) => {
    if (device.type === 'local') return statLocalPath(path);
    return withDeviceRsync(device, async (spec) => {
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
  });
}

async function copyToTempFile(
  spec: RsyncDeviceSpec,
  normPath: string
): Promise<FileOpResult<{ tmpPath: string; size: number; cleanup: () => void }>> {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rfile-'));
  const dest = join(dir, 'f');
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  const res = await runRsyncOrMissing(
    () =>
      runRsync(rsyncCopyArgs(spec, normPath, dest), {
        env: spec.env,
        timeoutMs: COPY_TIMEOUT_MS,
      }),
    cleanup
  );
  if (!res.ok) return res;
  if (res.data.exitCode !== 0) return rsyncFail(res.data.exitCode, res.data.stderr, cleanup);
  try {
    return ok({ tmpPath: dest, size: statSync(dest).size, cleanup });
  } catch {
    cleanup();
    return fail('unknown');
  }
}

async function copyToBuffer(
  spec: RsyncDeviceSpec,
  normPath: string
): Promise<FileOpResult<Buffer>> {
  const copied = await copyToTempFile(spec, normPath);
  if (!copied.ok) return copied;
  try {
    return ok(readFileSync(copied.data.tmpPath));
  } finally {
    copied.data.cleanup();
  }
}

export async function readTextFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<FileContentResponse>> {
  return withNormalized(rootId, inputPath, async ({ path, device }) => {
    if (device.type === 'local') return readLocalTextFile(path);
    return withDeviceRsync(device, async (spec) => {
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
  });
}

export type RawFileData = LocalFileHandle;

export async function readRawFile(
  rootId: string,
  inputPath: string
): Promise<FileOpResult<RawFileData>> {
  return withNormalized(rootId, inputPath, async ({ path, device }) => {
    if (device.type === 'local') return localFileHandle(path, RAW_MAX_BYTES);
    return withDeviceRsync(device, async (spec) => {
      const st = await statViaRsync(spec, path);
      if (!st.ok) return st;
      if (st.data.type === 'dir') return fail('is_directory');
      if (st.data.size != null && st.data.size > RAW_MAX_BYTES) return fail('too_large');
      const copied = await copyToTempFile(spec, path);
      if (!copied.ok) return copied;
      if (copied.data.size > RAW_MAX_BYTES) {
        copied.data.cleanup();
        return fail('too_large');
      }
      const name = posixBasename(path);
      return ok<RawFileData>({
        tmpPath: copied.data.tmpPath,
        size: copied.data.size,
        name,
        mime: mimeOf(name),
        cleanup: copied.data.cleanup,
      });
    });
  });
}

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

async function pushRemoteFile(
  spec: RsyncDeviceSpec,
  destDir: string,
  srcPath: string,
  safeName: string,
  opts: TransferOptions
): Promise<FileOpResult<{ uploaded: string }>> {
  const destStat = await statViaRsync(spec, destDir);
  if (!destStat.ok) return destStat;
  if (destStat.data.type !== 'dir') return fail('not_a_directory');
  const remoteDest = posixJoin(destDir, safeName);
  const res = await runRsyncOrMissing(() =>
    runRsync(rsyncUploadArgs(spec, srcPath, remoteDest), {
      env: spec.env,
      onProgress: opts.onProgress,
      idleTimeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
      signal: opts.signal,
    })
  );
  if (!res.ok) return res;
  if (res.data.exitCode !== 0) return rsyncFail(res.data.exitCode, res.data.stderr);
  return ok({ uploaded: safeName });
}

export async function pushFileToDevice(
  rootId: string,
  destDir: string,
  srcPath: string,
  name: string,
  opts: TransferOptions = {}
): Promise<FileOpResult<{ uploaded: string }>> {
  const safeName = sanitizeUploadName(name);
  if (!safeName) return fail('invalid');
  return withNormalized(rootId, destDir, async ({ path, device }) => {
    if (device.type === 'local') {
      return enqueueDeviceJob(device.id, async () => pushLocalFile(path, srcPath, safeName, opts));
    }
    return withDeviceRsync(device, (spec) => pushRemoteFile(spec, path, srcPath, safeName, opts));
  });
}

export type PulledFile = LocalFileHandle;

async function pullRemoteFile(
  spec: RsyncDeviceSpec,
  path: string,
  opts: TransferOptions
): Promise<FileOpResult<PulledFile>> {
  const st = await statViaRsync(spec, path);
  if (!st.ok) return st;
  if (st.data.type === 'dir') return fail('is_directory');
  const maxBytes = transferMaxBytesNow(config.transferMaxBytes);
  if (st.data.size != null && st.data.size > maxBytes) {
    return fail('too_large', String(maxBytes));
  }
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-dl-'));
  const dest = join(dir, 'f');
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  const res = await runRsyncOrMissing(
    () =>
      runRsync(rsyncCopyArgs(spec, path, dest), {
        env: spec.env,
        onProgress: opts.onProgress,
        idleTimeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
        signal: opts.signal,
      }),
    cleanup
  );
  if (!res.ok) return res;
  if (res.data.exitCode !== 0) return rsyncFail(res.data.exitCode, res.data.stderr, cleanup);
  const name = posixBasename(path);
  let size = st.data.size ?? 0;
  try {
    size = statSync(dest).size;
  } catch {
    // 退回 stat 大小
  }
  if (size > maxBytes) {
    cleanup();
    return fail('too_large', String(maxBytes));
  }
  return ok<PulledFile>({ tmpPath: dest, size, name, mime: mimeOf(name), cleanup });
}

export async function pullFileFromDevice(
  rootId: string,
  inputPath: string,
  opts: TransferOptions = {}
): Promise<FileOpResult<PulledFile>> {
  return withNormalized(rootId, inputPath, async ({ path, device }) => {
    if (device.type === 'local') {
      return localFileHandle(path, transferMaxBytesNow(config.transferMaxBytes));
    }
    return withDeviceRsync(device, (spec) => pullRemoteFile(spec, path, opts));
  });
}
