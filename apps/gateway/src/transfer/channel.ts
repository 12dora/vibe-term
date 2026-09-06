// 源节点 A 看到的「目标侧」抽象。两种实现：经 peer 链路的 mesh 通道，
// 以及 A === B 时直接调本进程接收服务的本机通道。

import type { TransferCapability, TransferErrorCode } from '@tmex/shared';
import type { ByteRange, PushOutcome, ReceivedState } from '@tmex/transfer';
import {
  type OpenSessionResult,
  closeSession,
  commitFile,
  fileStatus,
  getSession,
  openSession,
  writeFileRange,
} from './receiver';

export const MESH_TRANSFER_PREFIX = '/api/mesh-internal/transfer';

export interface ChannelFailure {
  ok: false;
  code: TransferErrorCode;
  detail?: string;
}

export type ChannelResult<T> = ({ ok: true } & T) | ChannelFailure;
export type ChannelVoid = { ok: true } | ChannelFailure;

export interface TransferChannel {
  open(
    grant: { grantId: string; token: string },
    onConflict: 'skip' | 'overwrite',
    signal: AbortSignal
  ): Promise<ChannelResult<OpenSessionResult>>;
  status(
    sessionId: string,
    file: { relPath: string; size: number },
    signal: AbortSignal
  ): Promise<ReceivedState | null>;
  put(
    sessionId: string,
    file: { relPath: string; size: number },
    range: ByteRange,
    body: ReadableStream<Uint8Array>,
    opts: { signal: AbortSignal; onProgress: (uploaded: number) => void }
  ): Promise<PushOutcome>;
  commit(
    sessionId: string,
    file: { relPath: string; size: number },
    signal: AbortSignal
  ): Promise<ChannelVoid>;
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

/** A === B：省掉一整条链路，语义与远端完全一致（同一个接收服务）。 */
export function createLocalChannel(selfNodeId: string): TransferChannel {
  const resolve = (sessionId: string) => getSession(sessionId, selfNodeId);
  return {
    async open(grant, onConflict) {
      const opened = openSession({
        grantId: grant.grantId,
        token: grant.token,
        peerNodeId: selfNodeId,
        onConflict,
      });
      return opened;
    },
    async status(sessionId, file) {
      const session = resolve(sessionId);
      if (!session) return null;
      const state = await fileStatus(session, file.relPath, file.size);
      if (!state.ok) return null;
      return toReceivedState({ ...state, size: file.size });
    },
    async put(sessionId, file, range, body, opts) {
      const session = resolve(sessionId);
      if (!session) return { kind: 'fail', error: 'session gone' };
      const written = await writeFileRange(
        session,
        { relPath: file.relPath, size: file.size, offset: range.offset, length: range.length },
        body
      );
      if (!written.ok) {
        return written.code === 'incomplete' || written.code === 'unknown'
          ? { kind: 'retry', error: written.code }
          : { kind: 'fail', error: written.code };
      }
      opts.onProgress(range.length);
      return { kind: 'landed' };
    },
    async commit(sessionId, file) {
      const session = resolve(sessionId);
      if (!session) return { ok: false, code: 'not_found' };
      const done = await commitFile(session, file.relPath, file.size);
      return done.ok ? { ok: true } : done;
    },
    async close(sessionId) {
      closeSession(sessionId);
    },
  };
}

export type { OpenSessionResult, TransferCapability };
