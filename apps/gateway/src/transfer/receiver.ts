// 目标节点 B 上的接收服务：会话 + 区间落盘 + 落位。
// mesh-internal 路由与「A 就是 B」的本机复制都走这一份，保证两条路径的语义完全一致。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferCapability, TransferErrorCode } from '@tmex/shared';
import { ResumableSink, type SinkDescriptor } from '@tmex/transfer/node';
import { config } from '../config';
import { pushFileToDevice, statFile } from '../files/device-storage';
import { execSshCommand } from '../files/directory-browse';
import { withDeviceRsync } from '../files/rsync-operation';
import { transferMaxBytesNow } from '../files/transfer-limit';
import { quoteShellArg } from '../tmux-client/command-builder';
import {
  type DestContext,
  baseNameOf,
  ensureLocalParent,
  joinPosix,
  normalizeRelPath,
  parentOf,
  resolveDestContext,
} from './dest';
import { type TransferGrant, consumeGrant } from './grants';

export const SESSION_IDLE_MS = 10 * 60_000;
/** 单次 PUT 的体积上限，同时也是进度粒度。 */
export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const RECEIVER_CAPABILITIES: TransferCapability[] = [
  'transfer-v2',
  'transfer-ranged-parallel',
];

const sink = new ResumableSink();

interface ReceivingFile {
  relPath: string;
  size: number;
  descriptor: SinkDescriptor;
  /** ssh 目标：先落到本机暂存，commit 时再 rsync 推过去 */
  staged: boolean;
  committed: boolean;
}

export interface TransferSession {
  id: string;
  fromNodeId: string;
  uid: string;
  dest: DestContext;
  onConflict: 'skip' | 'overwrite';
  tmpDir: string | null;
  files: Map<string, ReceivingFile>;
  createdAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, TransferSession>();

export interface OpenSessionResult {
  sessionId: string;
  capabilities: TransferCapability[];
  maxFileBytes: number;
  chunkSize: number;
  expiresAt: number;
}

export type ReceiverFailure = { ok: false; code: TransferErrorCode; detail?: string };
export type ReceiverResult<T> = ({ ok: true } & T) | ReceiverFailure;
export type ReceiverVoid = { ok: true } | ReceiverFailure;

function fail(code: TransferErrorCode, detail?: string): ReceiverFailure {
  return { ok: false, code, detail };
}

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > SESSION_IDLE_MS) closeSession(id);
  }
}

export function openSession(input: {
  grantId: string;
  token: string;
  peerNodeId: string;
  onConflict?: 'skip' | 'overwrite';
  now?: number;
}): ReceiverResult<OpenSessionResult> {
  const now = input.now ?? Date.now();
  sweep(now);
  const consumed = consumeGrant({
    grantId: input.grantId,
    token: input.token,
    peerNodeId: input.peerNodeId,
    now,
  });
  if (!consumed.ok) return fail(consumed.code);
  return startSession(consumed.grant, input.onConflict ?? 'skip', now);
}

function startSession(
  grant: TransferGrant,
  onConflict: 'skip' | 'overwrite',
  now: number
): ReceiverResult<OpenSessionResult> {
  const dest = resolveDestContext(grant.destRootId, grant.destPath);
  if (!dest.ok) return fail(dest.code);
  const session: TransferSession = {
    id: randomBytes(16).toString('hex'),
    fromNodeId: grant.fromNodeId,
    uid: grant.uid,
    dest: dest.data,
    onConflict,
    tmpDir: null,
    files: new Map(),
    createdAt: now,
    lastUsedAt: now,
  };
  sessions.set(session.id, session);
  return {
    ok: true,
    sessionId: session.id,
    capabilities: RECEIVER_CAPABILITIES,
    maxFileBytes: transferMaxBytesNow(config.transferMaxBytes),
    chunkSize: TRANSFER_CHUNK_BYTES,
    expiresAt: now + SESSION_IDLE_MS,
  };
}

export function getSession(sessionId: string, peerNodeId: string): TransferSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.fromNodeId !== peerNodeId) return null;
  session.lastUsedAt = Date.now();
  return session;
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  for (const file of session.files.values()) {
    if (!file.committed) void sink.discard(file.descriptor).catch(() => {});
  }
  if (session.tmpDir) {
    try {
      rmSync(session.tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** 冲突检测：本机直接看 inode，ssh 设备只能问一次远端。 */
async function destExists(session: TransferSession, absPath: string): Promise<boolean> {
  if (session.dest.device.type === 'local') return existsSync(absPath);
  const stat = await statFile(session.dest.root.id, absPath);
  return stat.ok;
}

function sessionTmpDir(session: TransferSession): string {
  if (!session.tmpDir) session.tmpDir = mkdtempSync(join(tmpdir(), 'tmex-rx-'));
  return session.tmpDir;
}

async function prepareFile(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ file: ReceivingFile }>> {
  const existing = session.files.get(relPath);
  if (existing) return { ok: true, file: existing };
  const rel = normalizeRelPath(relPath);
  if (!rel) return fail('invalid');
  const limit = transferMaxBytesNow(config.transferMaxBytes);
  if (size > limit) return fail('quota_file_size');

  const staged = session.dest.device.type !== 'local';
  const abs = joinPosix(session.dest.destDir, rel);
  if (session.onConflict === 'skip' && (await destExists(session, abs))) {
    return fail('dest_exists');
  }
  let destPath: string;
  if (staged) {
    destPath = join(sessionTmpDir(session), rel);
  } else {
    const parent = await ensureLocalParent(session.dest, abs);
    if (!parent.ok) return fail(parent.code);
    destPath = abs;
  }
  const file: ReceivingFile = {
    relPath: rel,
    size,
    staged,
    committed: false,
    descriptor: {
      destPath,
      key: `${session.id}:${rel}`,
      mode: 'ranged',
      totalBytes: size,
      maxBytes: size,
      fileMode: 0o644,
    },
  };
  session.files.set(relPath, file);
  return { ok: true, file };
}

export async function fileStatus(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ receivedBytes: number; ranges: Array<[number, number]> }>> {
  const prepared = await prepareFile(session, relPath, size);
  if (!prepared.ok) return prepared;
  if (prepared.file.committed) {
    return { ok: true, receivedBytes: size, ranges: size > 0 ? [[0, size]] : [] };
  }
  const state = await sink.status(prepared.file.descriptor);
  return {
    ok: true,
    receivedBytes: state.receivedBytes,
    ranges: state.ranges.map((r) => [r.offset, r.length] as [number, number]),
  };
}

const WRITE_FAILURES: Record<string, TransferErrorCode> = {
  offset_mismatch: 'offset_mismatch',
  too_large: 'too_large',
  incomplete: 'incomplete',
  checksum_mismatch: 'checksum_mismatch',
  aborted: 'cancelled',
  invalid: 'invalid',
  io_error: 'unknown',
};

export async function writeFileRange(
  session: TransferSession,
  input: { relPath: string; size: number; offset: number; length?: number },
  body: ReadableStream<Uint8Array>
): Promise<ReceiverResult<{ received: number; complete: boolean }>> {
  const prepared = await prepareFile(session, input.relPath, input.size);
  if (!prepared.ok) return prepared;
  const file = prepared.file;
  if (file.committed) return { ok: true, received: file.size, complete: true };
  const written = await sink.write(file.descriptor, body, {
    offset: input.offset,
    contentLength: input.length,
  });
  session.lastUsedAt = Date.now();
  if (!written.ok) return fail(WRITE_FAILURES[written.code] ?? 'unknown');
  return { ok: true, received: written.receivedBytes, complete: written.complete };
}

/** 落位：本机设备直接 rename 到目标；ssh 设备先建远端目录再 rsync 推过去。 */
export async function commitFile(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ skipped: boolean }>> {
  const file = session.files.get(relPath);
  if (!file) return fail('not_found');
  // 建会话时登记的大小与提交时声明的对不上：说明两端对同一个 relPath 的认知已经分叉
  if (file.size !== size) return fail('invalid');
  if (file.committed) return { ok: true, skipped: false };
  const state = await sink.status(file.descriptor);
  if (!state.complete) return fail('incomplete');
  const committed = await sink.commit(file.descriptor);
  if (!committed.ok) return fail('unknown');
  file.committed = true;
  if (!file.staged) return { ok: true, skipped: false };
  return pushStagedFile(session, file);
}

async function pushStagedFile(
  session: TransferSession,
  file: ReceivingFile
): Promise<ReceiverResult<{ skipped: boolean }>> {
  const remoteDir = parentOf(joinPosix(session.dest.destDir, file.relPath));
  const made = await ensureRemoteDir(session, remoteDir);
  if (!made.ok) return made;
  const pushed = await pushFileToDevice(
    session.dest.root.id,
    remoteDir,
    file.descriptor.destPath,
    baseNameOf(file.relPath)
  );
  if (!pushed.ok) return fail(pushed.code, pushed.detail);
  return { ok: true, skipped: false };
}

async function ensureRemoteDir(session: TransferSession, remoteDir: string): Promise<ReceiverVoid> {
  if (remoteDir === session.dest.destDir) return { ok: true };
  const result = await withDeviceRsync(session.dest.device, async (spec) => {
    const res = await execSshCommand(spec, `mkdir -p ${quoteShellArg(remoteDir)}`);
    return res.exitCode === 0
      ? ({ ok: true, data: undefined } as const)
      : ({ ok: false, code: 'permission_denied' as const, detail: res.stderr } as const);
  });
  return result.ok ? { ok: true } : fail(result.code, result.detail);
}

// 空闲会话的兜底 GC：没有新会话进来时也要把半成品清掉，别把 `.part` 留在用户目录里。
const sessionGcTimer = setInterval(() => sweep(Date.now()), 60_000);
sessionGcTimer.unref?.();

export function resetTransferSessionsForTests(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}
