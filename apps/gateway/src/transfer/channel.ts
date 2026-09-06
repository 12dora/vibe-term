// 源节点 A 看到的「目标侧」抽象。两种实现：经 peer 链路的 mesh 通道，
// 以及 A === B 时直接调本进程接收服务的本机通道。

import type { TransferCapability, TransferErrorCode } from '@vibeterm/shared';
import type { ByteRange, PushOutcome, ReceivedState } from '@vibeterm/transfer';
import { normalizeTransferError } from './errors';
import {
  type OpenSessionResult,
  type TransferSession,
  closeSession,
  getSession,
  openSession,
} from './receiver';
import { commitFile, fileStatus, makeDirectory, writeFileRange } from './receiver-files';

export const MESH_TRANSFER_PREFIX = '/api/mesh-internal/transfer';

export interface ChannelFailure {
  ok: false;
  code: TransferErrorCode;
  detail?: string;
}

export type ChannelResult<T> = ({ ok: true } & T) | ChannelFailure;
export type ChannelVoid = { ok: true } | ChannelFailure;

export interface TransferFileRef {
  relPath: string;
  size: number;
}

export interface TransferChannel {
  open(
    grant: { grantId: string; token: string },
    onConflict: 'skip' | 'overwrite',
    signal: AbortSignal
  ): Promise<ChannelResult<OpenSessionResult>>;
  status(
    sessionId: string,
    file: TransferFileRef,
    signal: AbortSignal
  ): Promise<ReceivedState | null>;
  put(
    sessionId: string,
    file: TransferFileRef,
    range: ByteRange,
    body: ReadableStream<Uint8Array>,
    opts: { signal: AbortSignal; onProgress: (uploaded: number) => void }
  ): Promise<PushOutcome>;
  commit(
    sessionId: string,
    file: TransferFileRef,
    signal: AbortSignal
  ): Promise<ChannelResult<{ skipped: boolean }>>;
  /** 目录条目：只在目标侧建目录 */
  mkdir(sessionId: string, relPath: string, signal: AbortSignal): Promise<ChannelVoid>;
  /** 续期：源侧长时间在暂存文件时也要让目标会话活着 */
  keepAlive(sessionId: string, signal: AbortSignal): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export function toReceivedState(input: {
  receivedBytes: number;
  ranges: Array<[number, number]>;
  size: number;
}): ReceivedState {
  const ranges = input.ranges.map(([offset, length]) => ({ offset, length }));
  return {
    receivedBytes: input.receivedBytes,
    ranges,
    complete: input.size > 0 && input.receivedBytes >= input.size,
  };
}

/** 本机通道的取消：把 body 接到任务信号上，abort 时连读带写一起停。 */
function abortableBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
}

/** A === B：省掉一整条链路，语义与远端完全一致（同一个接收服务）。 */
export function createLocalChannel(selfNodeId: string): TransferChannel {
  const resolve = (sessionId: string): TransferSession | null => getSession(sessionId, selfNodeId);
  return {
    async open(grant, onConflict) {
      return openSession({
        grantId: grant.grantId,
        token: grant.token,
        peerNodeId: selfNodeId,
        onConflict,
      });
    },
    async status(sessionId, file) {
      const session = resolve(sessionId);
      if (!session) return null;
      const state = await fileStatus(session, file.relPath, file.size);
      if (!state.ok) return null;
      return toReceivedState({ ...state, size: file.size });
    },
    async put(sessionId, file, range, body, opts) {
      if (opts.signal.aborted) {
        await body.cancel().catch(() => {});
        return { kind: 'cancelled' };
      }
      const session = resolve(sessionId);
      if (!session) {
        await body.cancel().catch(() => {});
        return { kind: 'fail', error: 'not_found' };
      }
      const piped = abortableBody(body, opts.signal);
      const written = await writeFileRange(
        session,
        { relPath: file.relPath, size: file.size, offset: range.offset, length: range.length },
        piped
      );
      if (!written.ok) {
        // 本机通道没有 HTTP 层兜底：早退时得自己把文件流收掉
        await piped.cancel().catch(() => {});
      }
      if (opts.signal.aborted) return { kind: 'cancelled' };
      if (!written.ok) return classifyLocalFailure(written.code);
      opts.onProgress(range.length);
      return { kind: 'landed' };
    },
    async commit(sessionId, file, signal) {
      if (signal.aborted) return { ok: false, code: 'cancelled' };
      const session = resolve(sessionId);
      if (!session) return { ok: false, code: 'not_found' };
      const done = await commitFile(session, file.relPath, file.size);
      return done.ok ? { ok: true, skipped: done.skipped } : done;
    },
    async mkdir(sessionId, relPath, signal) {
      if (signal.aborted) return { ok: false, code: 'cancelled' };
      const session = resolve(sessionId);
      if (!session) return { ok: false, code: 'not_found' };
      return await makeDirectory(session, relPath);
    },
    async keepAlive(sessionId) {
      resolve(sessionId);
    },
    async close(sessionId) {
      await closeSession(sessionId);
    },
  };
}

/** 目标侧的可重试拒绝：链路/并发原因，退避后按新偏移续传即可。 */
const RETRYABLE: ReadonlySet<TransferErrorCode> = new Set<TransferErrorCode>([
  'incomplete',
  'offset_mismatch',
  'unknown',
  'timeout',
  'node_unreachable',
]);

function classifyLocalFailure(code: TransferErrorCode): PushOutcome {
  const normalized = normalizeTransferError(code);
  if (normalized === 'cancelled') return { kind: 'cancelled' };
  return RETRYABLE.has(normalized)
    ? { kind: 'retry', error: normalized }
    : { kind: 'fail', error: normalized };
}

export type { OpenSessionResult, TransferCapability };
