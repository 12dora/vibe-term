// 经 peer 链路（dc / ws-secure / relay 自动选择）访问目标节点 B 的接收服务。
// 所有调用都走 `/api/mesh-internal/transfer/*`：peer 标记保证对端身份，
// grant 保证「这台节点确实被授权往这个目录写」。

import type { TransferErrorCode } from '@vibeterm/shared';
import type { PushOutcome } from '@vibeterm/transfer';
import { type TransferMeshBridge, getTransferMeshBridge } from './bridge';
import {
  type ChannelResult,
  type ChannelVoid,
  MESH_TRANSFER_PREFIX,
  type OpenSessionResult,
  type TransferChannel,
  type TransferFileRef,
  toReceivedState,
} from './channel';
import { errorDetailOf, normalizeTransferError } from './errors';

type JsonBody = Record<string, unknown>;

async function readJson(res: Response): Promise<JsonBody> {
  try {
    return (await res.json()) as JsonBody;
  } catch {
    return {};
  }
}

/**
 * 响应体里的 `code` 一律过归一化：链路层返回的是 `NODE_UNREACHABLE` 这种大写常量，
 * 直接当契约码用会漏出 `TransferErrorCode` 之外的值。
 */
function errorCodeOf(body: JsonBody, res: Response): TransferErrorCode {
  const fallback: TransferErrorCode = res.status === 503 ? 'node_unreachable' : 'unknown';
  return normalizeTransferError(body.code ?? body.error, fallback);
}

function bridgeOrThrow(): TransferMeshBridge {
  const bridge = getTransferMeshBridge();
  if (!bridge) throw new Error('mesh bridge unavailable');
  return bridge;
}

function fileQuery(file: TransferFileRef, extra: string): string {
  return `?rel=${encodeURIComponent(file.relPath)}&size=${file.size}${extra}`;
}

export function createMeshChannel(nodeId: string): TransferChannel {
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    bridgeOrThrow().forwardInternalHttp(nodeId, `${MESH_TRANSFER_PREFIX}${path}`, body, signal);

  return {
    async open(grant, onConflict, signal) {
      const res = await post(
        '/sessions',
        { grantId: grant.grantId, token: grant.token, onConflict },
        signal
      );
      const body = await readJson(res);
      if (!res.ok) return { ok: false, code: errorCodeOf(body, res) };
      return { ok: true, ...(body as unknown as OpenSessionResult) };
    },

    async status(sessionId, file, signal) {
      const res = await post(
        `/sessions/${sessionId}/status`,
        { relPath: file.relPath, size: file.size },
        signal
      );
      const body = await readJson(res);
      if (!res.ok) return null;
      const ranges = Array.isArray(body.ranges) ? (body.ranges as Array<[number, number]>) : [];
      const receivedBytes = typeof body.receivedBytes === 'number' ? body.receivedBytes : 0;
      return toReceivedState({ receivedBytes, ranges, size: file.size });
    },

    async put(sessionId, file, range, body, opts) {
      let res: Response;
      try {
        res = await bridgeOrThrow().forwardInternalHttp(
          nodeId,
          `${MESH_TRANSFER_PREFIX}/sessions/${sessionId}/files`,
          null,
          opts.signal,
          {
            method: 'PUT',
            query: fileQuery(file, `&offset=${range.offset}&length=${range.length}`),
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(range.length),
            },
            rawBody: body,
            onProgress: opts.onProgress,
          }
        );
      } catch (err) {
        if (opts.signal.aborted) return { kind: 'cancelled' };
        return { kind: 'retry', error: errorDetailOf(err) ?? 'push failed' };
      }
      if (opts.signal.aborted) return { kind: 'cancelled' };
      return classifyPut(res, range.length, opts.onProgress);
    },

    async commit(sessionId, file, signal) {
      const res = await post(
        `/sessions/${sessionId}/commit`,
        { relPath: file.relPath, size: file.size },
        signal
      );
      const body = await readJson(res);
      if (res.ok) return { ok: true, skipped: body.skipped === true };
      return { ok: false, code: errorCodeOf(body, res), detail: errorDetailOf(body.detail) };
    },

    async mkdir(sessionId, relPath, signal): Promise<ChannelVoid> {
      const res = await post(`/sessions/${sessionId}/dirs`, { relPath }, signal);
      if (res.ok) return { ok: true };
      const body = await readJson(res);
      return { ok: false, code: errorCodeOf(body, res), detail: errorDetailOf(body.detail) };
    },

    async keepAlive(sessionId, signal) {
      await post(`/sessions/${sessionId}/keepalive`, {}, signal).catch(() => undefined);
    },

    async close(sessionId) {
      const bridge = getTransferMeshBridge();
      if (!bridge) return;
      await bridge
        .forwardInternalHttp(
          nodeId,
          `${MESH_TRANSFER_PREFIX}/sessions/${sessionId}`,
          null,
          undefined,
          { method: 'DELETE' }
        )
        .catch(() => undefined);
    },
  };
}

/** 目标侧的确定性拒绝：重试多少次结论都一样，不值得占着退避阶梯。 */
const TERMINAL_CODES = new Set<TransferErrorCode>([
  'dest_exists',
  'dest_conflict',
  'quota_file_size',
  'limit_exceeded',
  'too_large',
  'invalid',
  'outside_roots',
  'permission_denied',
  'root_not_found',
  'root_disabled',
  'device_not_found',
  'not_a_directory',
  'grant_invalid',
  'grant_expired',
  'peer_mismatch',
  'checksum_mismatch',
]);

/** 5xx / 半截区间 / 偏移不符可以退避后按新偏移续传；其余是确定性失败。 */
async function classifyPut(
  res: Response,
  length: number,
  onProgress: (uploaded: number) => void
): Promise<PushOutcome> {
  const body = await readJson(res);
  if (res.ok) {
    onProgress(length);
    return { kind: 'landed' };
  }
  const code = errorCodeOf(body, res);
  if (code === 'cancelled') return { kind: 'cancelled' };
  if (TERMINAL_CODES.has(code)) return { kind: 'fail', error: code };
  if (res.status >= 500 || res.status === 409) return { kind: 'retry', error: code };
  return { kind: 'fail', error: code };
}

export type { ChannelResult, ChannelVoid };
