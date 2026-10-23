// 上传会话的推送通道（`@vibeterm/transfer` 的 PushTransport 实现）：区间 PUT + 已收状态查询。

import type { PushTransport } from '@vibeterm/transfer';
import type { ApiClient } from './client';
import { FileApiError, parseError } from './file-errors';

type UploadStatusResponse = {
  size?: number;
  received?: number;
  complete?: boolean;
  ranges?: Array<[number, number]>;
};

/** 最近一次失败的原因，推送放弃时据此决定抛服务端错误还是「传输中断」。 */
export interface UploadFailureLog {
  error: unknown;
  /** 已记下服务端的永久性拒绝（401/403/404/413…），之后的失败不再覆盖它。 */
  permanent?: boolean;
}

/**
 * 记录失败原因。被驱动自己收掉的在飞请求（兄弟请求出了结论后 abort）报的 AbortError 不是原因；
 * 服务端给的 FileApiError 也不能被后到的链路错误顶掉，否则用户只看到「网络中断」。
 */
function recordFailure(
  failure: UploadFailureLog,
  error: unknown,
  attemptSignal: AbortSignal,
  permanent: boolean
): void {
  if (attemptSignal.aborted || failure.permanent) return;
  if (failure.error instanceof FileApiError && !(error instanceof FileApiError)) return;
  failure.error = error;
  failure.permanent = permanent;
}

export interface UploadTransportInput {
  client: ApiClient;
  uploadId: string;
  file: Blob;
  signal: AbortSignal | undefined;
  ranged: boolean;
  failure: UploadFailureLog;
}

/**
 * 第一轮不问已收区间（刚建的会话必然是空的），之后每轮都问一次，只补发缺口。
 * PUT 走 `client.upload`，把请求体的实时上行字节作为区间内进度交给驱动。
 */
export function createUploadTransport(input: UploadTransportInput): PushTransport {
  const { client, uploadId, file, signal, ranged, failure } = input;
  let asked = false;
  return {
    // 状态查询也走本轮的带期限信号：卡死的响应不能把整轮尝试吊在这里。
    async status(attemptSignal) {
      if (!asked) {
        asked = true;
        return null;
      }
      try {
        const res = await client.fetch(`/api/files/upload/${uploadId}`, {
          signal: attemptSignal,
          purpose: 'transfer',
        });
        if (!res.ok) return null;
        const body = (await res.json()) as UploadStatusResponse;
        const ranges = (body.ranges ?? []).map(([offset, length]) => ({ offset, length }));
        return {
          receivedBytes: body.received ?? 0,
          ranges: ranged ? ranges : [],
          complete: body.complete === true,
        };
      } catch {
        return null;
      }
    },
    async put(range, opts) {
      if (signal?.aborted) return { kind: 'cancelled' };
      if (opts.signal.aborted) return { kind: 'retry', error: 'upload attempt aborted' };
      const query = `?offset=${range.offset}&length=${range.length}`;
      let res: Response;
      try {
        // 请求与响应体都挂在本轮信号上：期限一到或本轮已出结论，在飞的 PUT 立刻收掉。
        res = await client.upload(`/api/files/upload/${uploadId}${query}`, {
          method: 'PUT',
          body: file.slice(range.offset, range.offset + range.length),
          signal: opts.signal,
          purpose: 'transfer',
          onUploadProgress: opts.onProgress,
        });
      } catch (err) {
        if (signal?.aborted) return { kind: 'cancelled' };
        recordFailure(failure, err, opts.signal, false);
        return { kind: 'retry', error: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        await res.text().catch(() => '');
        return { kind: 'landed' };
      }
      if (signal?.aborted) return { kind: 'cancelled' };
      const error = await parseError(res);
      // 409 = 半截区间 / 区间冲突，5xx = 链路或服务端抖动；都可以退避后按新偏移续传。
      const transient = res.status === 409 || res.status >= 500;
      recordFailure(failure, error, opts.signal, !transient);
      return { kind: transient ? 'retry' : 'fail', error: error.message };
    },
  };
}
