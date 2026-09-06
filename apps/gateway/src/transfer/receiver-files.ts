// 接收侧的逐文件操作：登记（含落点授权与预算）、区间落盘、落位。
// 会话生命周期在 `receiver.ts`，这里的每个入口都用 `beginOp/endOp` 圈住，
// 保证关闭时能等到它们收尾再清理。

import { rm } from 'node:fs/promises';
import { type SinkDescriptor, partPathOf } from '@vibeterm/transfer/node';
import { normalizeRelPath } from './dest';
import { resolveAuthorizedDir, resolveAuthorizedFile } from './dest-local';
import { ensureRemoteDir, placeFileOnRemote, probeRemoteTarget } from './dest-remote';
import { normalizeTransferError } from './errors';
import { MAX_SESSION_ACTIVE_WRITES, MAX_SESSION_FILES } from './limits';
import {
  type ReceiverResult,
  type ReceiverVoid,
  type ReceivingFile,
  type TransferSession,
  beginOp,
  claimPart,
  endOp,
  receiverFail,
  releasePart,
  touchSession,
} from './receiver';
import { receiverSink } from './receiver-sink';

/** 每收到一块字节就给会话续命：一个大分片传很久也不该被空闲回收掉。 */
function touchedBody(
  session: TransferSession,
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        touchSession(session);
        controller.enqueue(chunk);
      },
    })
  );
}

function descriptorFor(session: TransferSession, rel: string, size: number, destPath: string) {
  const descriptor: SinkDescriptor = {
    destPath,
    // 半成品身份绑定 grant 作用域 + 相对路径 + 大小：换一张 grant、换一个会话都能接着传，
    // 但内容不同（大小不同）的文件绝不会共用同一个半成品。
    key: `${session.scopeKey}\0${rel}\0${size}`,
    mode: 'ranged',
    totalBytes: size,
    maxBytes: size,
    fileMode: 0o644,
  };
  return descriptor;
}

async function resolveDestPath(
  session: TransferSession,
  rel: string,
  size: number
): Promise<ReceiverResult<{ destPath: string; staged: boolean; exists: boolean }>> {
  if (session.stagingDir) {
    const probe = session.onConflict === 'skip' ? await probeRemoteTarget(session.dest, rel) : null;
    if (probe && !probe.ok) return receiverFail(normalizeTransferError(probe.code), probe.detail);
    return {
      ok: true,
      destPath: `${session.stagingDir}/${rel}`,
      staged: true,
      exists: probe?.ok === true && probe.data.exists,
    };
  }
  const resolved = resolveAuthorizedFile(session.dest.realDestDir, rel, {
    create: true,
    partPathOf: (abs) => partPathOf(descriptorFor(session, rel, size, abs)),
  });
  if (!resolved.ok) return receiverFail(normalizeTransferError(resolved.code));
  return { ok: true, destPath: resolved.data.absPath, staged: false, exists: resolved.data.exists };
}

function checkBudget(session: TransferSession, size: number): ReceiverVoid {
  if (session.files.size >= MAX_SESSION_FILES) return receiverFail('limit_exceeded');
  if (size > session.maxFileBytes) return receiverFail('quota_file_size');
  if (session.bytesRegistered + size > session.maxBytes) return receiverFail('limit_exceeded');
  return { ok: true };
}

/**
 * 登记一个文件。同一 relPath 只登记一次，声明大小变了直接判冲突——
 * 复用旧记录会让「同名不同源」的第二个文件拿到第一个文件的完成状态，一个字节没传却报成功。
 */
async function prepareFile(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ file: ReceivingFile }>> {
  const rel = normalizeRelPath(relPath);
  if (!rel) return receiverFail('invalid');
  const existing = session.files.get(rel);
  if (existing) {
    if (existing.size !== size) return receiverFail('dest_conflict');
    return { ok: true, file: existing };
  }
  const budget = checkBudget(session, size);
  if (!budget.ok) return budget;
  const dest = await resolveDestPath(session, rel, size);
  if (!dest.ok) return dest;
  if (dest.exists && session.onConflict === 'skip') return receiverFail('dest_exists');
  const descriptor = descriptorFor(session, rel, size, dest.destPath);
  const partPath = partPathOf(descriptor);
  if (!claimPart(session, partPath)) return receiverFail('dest_conflict');
  const file: ReceivingFile = {
    relPath: rel,
    size,
    descriptor,
    staged: dest.staged,
    stagedDone: false,
    committed: false,
    skipped: false,
    partClaim: partPath,
  };
  session.files.set(rel, file);
  session.bytesRegistered += size;
  return { ok: true, file };
}

export async function fileStatus(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ receivedBytes: number; ranges: Array<[number, number]> }>> {
  const started = beginOp(session);
  if (!started.ok) return started;
  try {
    const prepared = await prepareFile(session, relPath, size);
    if (!prepared.ok) return prepared;
    if (prepared.file.committed) {
      return { ok: true, receivedBytes: size, ranges: size > 0 ? [[0, size]] : [] };
    }
    const state = await receiverSink.status(prepared.file.descriptor);
    return {
      ok: true,
      receivedBytes: state.receivedBytes,
      ranges: state.ranges.map((r) => [r.offset, r.length] as [number, number]),
    };
  } finally {
    endOp(session);
  }
}

const WRITE_FAILURES: Record<string, ReturnType<typeof normalizeTransferError>> = {
  offset_mismatch: 'offset_mismatch',
  // 与另一条在写的流重叠：退避后按新偏移重来即可，语义与偏移不符一致
  conflict: 'offset_mismatch',
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
  // 早退路径不动 body：请求体归调用方（mesh 路由 / 本机通道）处置，
  // 在这里 cancel 会把整条 mux 流 RST 掉，发送端就收不到这个明确的错误码了。
  const started = beginOp(session);
  if (!started.ok) return started;
  try {
    const prepared = await prepareFile(session, input.relPath, input.size);
    if (!prepared.ok) return prepared;
    const file = prepared.file;
    if (file.committed) return { ok: true, received: file.size, complete: true };
    if (session.activeWrites >= MAX_SESSION_ACTIVE_WRITES) return receiverFail('limit_exceeded');
    session.activeWrites += 1;
    try {
      return await runWrite(session, file, input, body);
    } finally {
      session.activeWrites -= 1;
    }
  } finally {
    endOp(session);
  }
}

async function runWrite(
  session: TransferSession,
  file: ReceivingFile,
  input: { offset: number; length?: number },
  body: ReadableStream<Uint8Array>
): Promise<ReceiverResult<{ received: number; complete: boolean }>> {
  const written = await receiverSink.write(file.descriptor, touchedBody(session, body), {
    offset: input.offset,
    contentLength: input.length,
    signal: session.abort.signal,
  });
  touchSession(session);
  if (written.ok) return { ok: true, received: written.receivedBytes, complete: written.complete };
  // 半成品已经落位封存：这次写入没有意义，但文件本身是好的
  if (written.code === 'sealed') return { ok: true, received: file.size, complete: true };
  return receiverFail(WRITE_FAILURES[written.code] ?? 'unknown');
}

/**
 * 落位。本机目标由 sink 原子完成（`skip` 用 link 抢占，不存在「先查后改名」的空窗）；
 * ssh 目标先把本机暂存文件收好（`stagedDone`），再推到远端，推成功才算 `committed`——
 * 推失败时重复调用会从推送这一步接着来，绝不谎报完成。
 */
export async function commitFile(
  session: TransferSession,
  relPath: string,
  size: number
): Promise<ReceiverResult<{ skipped: boolean }>> {
  const rel = normalizeRelPath(relPath);
  if (!rel) return receiverFail('invalid');
  const file = session.files.get(rel);
  if (!file) return receiverFail('not_found');
  // 建会话时登记的大小与提交时声明的对不上：两端对同一个 relPath 的认知已经分叉
  if (file.size !== size) return receiverFail('dest_conflict');
  if (file.committed) return { ok: true, skipped: file.skipped };
  const started = beginOp(session);
  if (!started.ok) return started;
  try {
    const staged = await stageLocal(session, file);
    if (!staged.ok) return staged;
    if (!file.staged) return { ok: true, skipped: file.skipped };
    return await pushStaged(session, file);
  } finally {
    endOp(session);
  }
}

async function stageLocal(session: TransferSession, file: ReceivingFile): Promise<ReceiverVoid> {
  if (file.stagedDone) return { ok: true };
  const state = await receiverSink.status(file.descriptor);
  if (!state.complete) return receiverFail('incomplete');
  const placed = await receiverSink.commit(file.descriptor, {
    // 暂存目录是本模块独占的，冲突策略只对最终目标有意义
    onConflict: file.staged ? 'overwrite' : session.onConflict,
  });
  if (!placed.ok) return receiverFail('unknown');
  file.stagedDone = true;
  if (!file.staged) {
    file.committed = true;
    file.skipped = placed.skipped;
    finishClaim(session, file);
  }
  return { ok: true };
}

async function pushStaged(
  session: TransferSession,
  file: ReceivingFile
): Promise<ReceiverResult<{ skipped: boolean }>> {
  const pushed = await placeFileOnRemote(session.dest, {
    rel: file.relPath,
    localPath: file.descriptor.destPath,
    onConflict: session.onConflict,
    signal: session.abort.signal,
  });
  if (!pushed.ok) return receiverFail(normalizeTransferError(pushed.code), pushed.detail);
  file.committed = true;
  file.skipped = pushed.data.skipped;
  finishClaim(session, file);
  await rm(file.descriptor.destPath, { force: true }).catch(() => {});
  return { ok: true, skipped: pushed.data.skipped };
}

function finishClaim(session: TransferSession, file: ReceivingFile): void {
  if (!file.partClaim) return;
  releasePart(session, file.partClaim);
  file.partClaim = null;
}

/** 目录条目：只建目录，不传字节。走与文件落点完全相同的授权解析。 */
export async function makeDirectory(
  session: TransferSession,
  relPath: string
): Promise<ReceiverVoid> {
  const rel = normalizeRelPath(relPath);
  if (!rel) return receiverFail('invalid');
  const started = beginOp(session);
  if (!started.ok) return started;
  try {
    if (session.stagingDir) {
      const made = await ensureRemoteDir(session.dest, rel);
      return made.ok ? { ok: true } : receiverFail(normalizeTransferError(made.code), made.detail);
    }
    const made = resolveAuthorizedDir(session.dest.realDestDir, rel.split('/'), true);
    return made.ok ? { ok: true } : receiverFail(normalizeTransferError(made.code));
  } finally {
    endOp(session);
  }
}
