// cp 编排：判定 local↔node / node↔node，处理 -r 与 --on-conflict。

import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliContext } from './context';
import { CliError, InterruptError, UsageError, errorText, throwIfAborted } from './errors';
import {
  type FileStatDto,
  MkdirUnsupportedError,
  mkdirRemote,
  resolveRemotePath,
  statRemote,
} from './files-api';
import {
  isLocalPath,
  parseRemoteFileRef,
  posixBasename,
  posixDirname,
  posixJoin,
} from './files-path';
import type { HttpClient } from './http';
import { downloadRemoteFile, uploadLocalFile } from './transfer-local';
import { type OnConflict, copyPeer } from './transfer-peer';
import type { CopyProgress } from './transfer-progress';
import { emptyDirRels, walkLocal, walkRemote } from './transfer-walk';

export interface CopyFlags {
  recursive: boolean;
  onConflict: OnConflict;
  failOnSkip: boolean;
  signal?: AbortSignal;
}

export interface CopyResult {
  src: string;
  dst: string;
  kind: 'local-node' | 'node-local' | 'node-node';
  files: number;
  skipped: number;
  errors: number;
  truncated: boolean;
}

class RemoteDirCache {
  private readonly seen = new Set<string>();

  constructor(
    private readonly http: HttpClient,
    private readonly nodeId: string,
    private readonly rootId: string
  ) {}

  async ensure(path: string, signal?: AbortSignal): Promise<void> {
    if (this.seen.has(path)) return;
    await mkdirRemote(
      this.http,
      this.nodeId,
      { rootId: this.rootId, path, recursive: true },
      signal
    );
    this.seen.add(path);
  }
}

export function expandLocalPath(input: string): string {
  const raw = input.trim();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  if (raw.startsWith('file:')) return raw.replace(/^file:\/\//, '');
  return raw;
}

export async function runCopy(
  ctx: CliContext,
  srcArg: string,
  dstArg: string,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const srcLocal = isLocalPath(srcArg);
  const dstLocal = isLocalPath(dstArg);
  if (srcLocal && dstLocal) {
    throw new UsageError('local-to-local copy is not handled by vibeterm cp', 'use the system cp');
  }
  if (srcLocal && !dstLocal) {
    return copyLocalToNode(
      ctx,
      expandLocalPath(srcArg),
      parseRemoteFileRef(dstArg),
      flags,
      progress
    );
  }
  if (!srcLocal && dstLocal) {
    return copyNodeToLocal(
      ctx,
      parseRemoteFileRef(srcArg),
      expandLocalPath(dstArg),
      flags,
      progress
    );
  }
  return copyNodeToNode(
    ctx,
    parseRemoteFileRef(srcArg),
    parseRemoteFileRef(dstArg),
    flags,
    progress
  );
}

async function copyLocalToNode(
  ctx: CliContext,
  localPath: string,
  destRef: ReturnType<typeof parseRemoteFileRef>,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const dest = await resolveRemotePath(ctx, destRef);
  const source = await stat(localPath);
  if (source.isDirectory()) {
    if (!flags.recursive) throw new UsageError(`source is a directory: ${localPath}`, 'pass -r');
    return uploadTree(ctx, localPath, dest, flags, progress);
  }
  const destStat = await statRemoteSafe(ctx, dest.nodeId, dest.root.id, dest.absPath);
  const { destDir, name } = await pickRemoteDest(
    ctx,
    dest,
    destStat,
    posixBasename(localPath),
    flags
  );
  if (!name) return emptyResult(localPath, destRefDisplay(dest), 'local-node', 1);
  const dirs = new RemoteDirCache(ctx.http, dest.nodeId, dest.root.id);
  try {
    await dirs.ensure(destDir, flags.signal);
  } catch (error) {
    if (!(error instanceof MkdirUnsupportedError)) throw error;
    const existingDir = await statRemoteSafe(ctx, dest.nodeId, dest.root.id, destDir);
    if (existingDir?.type !== 'dir') throw error;
  }
  await uploadLocalFile({
    http: ctx.http,
    nodeId: dest.nodeId,
    rootId: dest.root.id,
    destDir,
    localPath,
    name,
    size: source.size,
    progress,
    signal: flags.signal,
  });
  return {
    src: localPath,
    dst: posixJoin(destDir, name),
    kind: 'local-node',
    files: 1,
    skipped: 0,
    errors: 0,
    truncated: false,
  };
}

async function uploadTree(
  ctx: CliContext,
  localRoot: string,
  dest: Awaited<ReturnType<typeof resolveRemotePath>>,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const destStat = await statRemoteSafe(ctx, dest.nodeId, dest.root.id, dest.absPath);
  const destBase =
    destStat?.type === 'dir' ? posixJoin(dest.absPath, posixBasename(localRoot)) : dest.absPath;
  const walked = await walkLocal(localRoot);
  let skipped = walked.skipped.length;
  for (const skip of walked.skipped) {
    progress.emit({ type: 'item', path: skip.rel, reason: skip.reason });
  }
  const dirs = new RemoteDirCache(ctx.http, dest.nodeId, dest.root.id);
  try {
    await dirs.ensure(destBase, flags.signal);
  } catch (error) {
    if (!(error instanceof MkdirUnsupportedError)) throw error;
    for (const rel of emptyDirRels(walked.entries)) {
      skipped += 1;
      progress.emit({ type: 'item', path: rel, reason: 'empty-dir' });
    }
    throw error;
  }
  for (const entry of walked.entries) {
    if (entry.dir) await dirs.ensure(posixJoin(destBase, entry.rel), flags.signal);
  }
  return uploadTreeFiles(ctx, localRoot, dest, destBase, walked.entries, flags, progress, skipped);
}

async function uploadTreeFiles(
  ctx: CliContext,
  localRoot: string,
  dest: Awaited<ReturnType<typeof resolveRemotePath>>,
  destBase: string,
  entries: Array<{ abs: string; rel: string; size: number; dir: boolean }>,
  flags: CopyFlags,
  progress: CopyProgress,
  skippedStart: number
): Promise<CopyResult> {
  const files = entries.filter((entry) => !entry.dir);
  let uploaded = 0;
  let skipped = skippedStart;
  let errors = 0;
  for (const file of files) {
    throwIfAborted(flags.signal);
    const destDir = file.rel.includes('/') ? posixJoin(destBase, posixDirname(file.rel)) : destBase;
    const name = posixBasename(file.rel);
    const existing = await statRemoteSafe(ctx, dest.nodeId, dest.root.id, posixJoin(destDir, name));
    const picked = await pickRemoteDest(
      ctx,
      { ...dest, absPath: posixJoin(destDir, name) },
      existing,
      name,
      flags
    );
    if (!picked.name) {
      skipped += 1;
      progress.emit({ type: 'item', path: file.rel, reason: 'conflict' });
      continue;
    }
    try {
      await uploadLocalFile({
        http: ctx.http,
        nodeId: dest.nodeId,
        rootId: dest.root.id,
        destDir: picked.destDir,
        localPath: file.abs,
        name: picked.name,
        size: file.size,
        progress,
        signal: flags.signal,
      });
      uploaded += 1;
    } catch (error) {
      if (error instanceof InterruptError || error instanceof MkdirUnsupportedError) throw error;
      errors += 1;
      progress.emit({ type: 'error', message: errorText(error), path: file.rel });
    }
  }
  return {
    src: localRoot,
    dst: destBase,
    kind: 'local-node',
    files: uploaded,
    skipped,
    errors,
    truncated: false,
  };
}

async function copyNodeToLocal(
  ctx: CliContext,
  srcRef: ReturnType<typeof parseRemoteFileRef>,
  localPath: string,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const src = await resolveRemotePath(ctx, srcRef);
  const remote = await statRemote(ctx.http, src.nodeId, src.root.id, src.absPath);
  if (remote.type === 'dir') {
    if (!flags.recursive) throw new UsageError(`source is a directory: ${src.absPath}`, 'pass -r');
    return downloadTree(ctx, src, remote, localPath, flags, progress);
  }
  const destPath = await pickLocalDest(localPath, remote.name, flags, false);
  if (!destPath) return emptyResult(src.absPath, localPath, 'node-local', 1);
  await mkdir(dirname(destPath), { recursive: true });
  await downloadRemoteFile({
    http: ctx.http,
    nodeId: src.nodeId,
    rootId: src.root.id,
    absPath: src.absPath,
    destPath,
    name: remote.name,
    progress,
    signal: flags.signal,
  });
  return {
    src: src.absPath,
    dst: destPath,
    kind: 'node-local',
    files: 1,
    skipped: 0,
    errors: 0,
    truncated: false,
  };
}

async function downloadTree(
  ctx: CliContext,
  src: Awaited<ReturnType<typeof resolveRemotePath>>,
  remote: FileStatDto,
  localPath: string,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const destRoot = await pickLocalDir(localPath, remote.name);
  await mkdir(destRoot, { recursive: true });
  const walked = await walkRemote(ctx.http, src.nodeId, src.root.id, src.absPath);
  if (walked.truncated) {
    progress.emit({
      type: 'error',
      message: 'directory listing was truncated at 2000 entries per folder',
    });
  }
  let files = 0;
  let skipped = walked.skipped.length;
  let errors = 0;
  for (const skip of walked.skipped) {
    progress.emit({ type: 'item', path: skip.rel, reason: skip.reason });
  }
  for (const entry of walked.entries) {
    throwIfAborted(flags.signal);
    if (entry.dir) {
      await mkdir(join(destRoot, entry.rel), { recursive: true });
      continue;
    }
    const destPath = await pickLocalDest(
      join(destRoot, entry.rel),
      posixBasename(entry.rel),
      flags,
      true
    );
    if (!destPath) {
      skipped += 1;
      progress.emit({ type: 'item', path: entry.rel, reason: 'conflict' });
      continue;
    }
    try {
      await mkdir(dirname(destPath), { recursive: true });
      await downloadRemoteFile({
        http: ctx.http,
        nodeId: src.nodeId,
        rootId: src.root.id,
        absPath: entry.abs,
        destPath,
        name: posixBasename(entry.rel),
        progress,
        signal: flags.signal,
      });
      files += 1;
    } catch (error) {
      if (error instanceof InterruptError) throw error;
      errors += 1;
      progress.emit({ type: 'error', message: errorText(error), path: entry.rel });
    }
  }
  return {
    src: src.absPath,
    dst: destRoot,
    kind: 'node-local',
    files,
    skipped,
    errors,
    truncated: walked.truncated,
  };
}

async function copyNodeToNode(
  ctx: CliContext,
  srcRef: ReturnType<typeof parseRemoteFileRef>,
  dstRef: ReturnType<typeof parseRemoteFileRef>,
  flags: CopyFlags,
  progress: CopyProgress
): Promise<CopyResult> {
  const src = await resolveRemotePath(ctx, srcRef);
  const dest = await resolveRemotePath(ctx, dstRef);
  const remote = await statRemote(ctx.http, src.nodeId, src.root.id, src.absPath);
  if (remote.type === 'dir' && !flags.recursive) {
    throw new UsageError(`source is a directory: ${src.absPath}`, 'pass -r');
  }
  const destStat = await statRemoteSafe(ctx, dest.nodeId, dest.root.id, dest.absPath);
  rejectPeerRename(remote, destStat, dest.absPath);
  const destPath =
    destStat?.type === 'dir' || remote.type === 'dir' ? dest.absPath : posixDirname(dest.absPath);
  const job = await copyPeer(ctx, {
    sourceNodeId: src.nodeId,
    destNodeId: dest.nodeId,
    sourceRootId: src.root.id,
    destRootId: dest.root.id,
    items: [{ rootId: src.root.id, path: src.absPath }],
    destPath,
    onConflict: flags.onConflict,
    progress,
    signal: flags.signal,
  });
  return {
    src: src.absPath,
    dst: dest.absPath,
    kind: 'node-node',
    files: job.items.filter((item) => item.state === 'done').length,
    skipped: job.items.filter((item) => item.state === 'skipped').length,
    errors: job.items.filter((item) => item.state === 'failed').length,
    truncated: false,
  };
}

function rejectPeerRename(
  remote: FileStatDto,
  destStat: FileStatDto | null,
  destAbs: string
): void {
  if (remote.type === 'dir' || destStat?.type === 'dir') return;
  const destName = posixBasename(destAbs);
  if (destName && destName !== remote.name) {
    throw new UsageError(
      'node-to-node copy cannot rename a file',
      'pass an existing directory as the destination'
    );
  }
}

async function statRemoteSafe(
  ctx: CliContext,
  nodeId: string,
  rootId: string,
  absPath: string
): Promise<FileStatDto | null> {
  try {
    return await statRemote(ctx.http, nodeId, rootId, absPath);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 4) return null;
    throw error;
  }
}

async function pickRemoteDest(
  ctx: CliContext,
  dest: Awaited<ReturnType<typeof resolveRemotePath>>,
  destStat: FileStatDto | null,
  sourceName: string,
  flags: CopyFlags
): Promise<{ destDir: string; name: string | null }> {
  if (destStat?.type === 'dir') return { destDir: dest.absPath, name: sourceName };
  if (!destStat) {
    return { destDir: posixDirname(dest.absPath), name: posixBasename(dest.absPath) || sourceName };
  }
  if (flags.onConflict === 'skip') return { destDir: posixDirname(dest.absPath), name: null };
  if (flags.onConflict === 'overwrite') {
    return { destDir: posixDirname(dest.absPath), name: posixBasename(dest.absPath) };
  }
  return {
    destDir: posixDirname(dest.absPath),
    name: await uniqueRemoteName(ctx, dest, posixBasename(dest.absPath)),
  };
}

async function uniqueRemoteName(
  ctx: CliContext,
  dest: Awaited<ReturnType<typeof resolveRemotePath>>,
  name: string
): Promise<string> {
  const dir = posixDirname(dest.absPath);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    const existing = await statRemoteSafe(
      ctx,
      dest.nodeId,
      dest.root.id,
      posixJoin(dir, candidate)
    );
    if (!existing) return candidate;
  }
  throw new CliError('could not pick a free name on the destination');
}

async function pickLocalDest(
  localPath: string,
  sourceName: string,
  flags: CopyFlags,
  destIsFile: boolean
): Promise<string | null> {
  let info: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    info = await stat(localPath);
  } catch {
    info = null;
  }
  let target = localPath;
  if (info?.isDirectory() && !destIsFile) target = join(localPath, sourceName);
  else if (info?.isDirectory() && destIsFile) target = localPath;
  try {
    info = await stat(target);
  } catch {
    return target;
  }
  if (!info) return target;
  if (flags.onConflict === 'skip') return null;
  if (flags.onConflict === 'overwrite') return target;
  return uniqueLocalPath(target);
}

async function pickLocalDir(localPath: string, sourceName: string): Promise<string> {
  try {
    const info = await stat(localPath);
    if (info.isDirectory()) return join(localPath, sourceName);
  } catch {
    return localPath;
  }
  return localPath;
}

async function uniqueLocalPath(path: string): Promise<string> {
  const dir = dirname(path);
  const base = posixBasename(path);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(dir, `${stem} (${index})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new CliError('could not pick a free local name');
}

function emptyResult(
  src: string,
  dst: string,
  kind: CopyResult['kind'],
  skipped: number
): CopyResult {
  return { src, dst, kind, files: 0, skipped, errors: 0, truncated: false };
}

function destRefDisplay(dest: Awaited<ReturnType<typeof resolveRemotePath>>): string {
  return `${dest.nodeId}:${dest.root.name}${dest.absPath}`;
}
