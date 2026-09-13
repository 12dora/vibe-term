// 远程升级作业的收发管道：请求脱壳、退避睡眠、上游错误摘要、交签名清单
//（包体读流已并入 `@vibeterm/transfer/node`）。都是与作业状态机无关的纯管道，
// 单独放一处让状态机文件只剩流程。

import { errorMessage, withTimeout } from '@vibeterm/shared';
import type { PushOutcome } from '@vibeterm/transfer';
import { getInstallInfo } from './install-info';
import {
  type DownloadProgressFn,
  downloadVerifiedRelease,
  resolveReleaseCacheDir,
} from './release-download';
import { resolveUpgradeInstallDir } from './upgrade';
import type { AuthorizedUpgradeForward } from './upgrade-service';
import { rangesFromPairs } from './upgrade-staging';

export const RANGED_PUSH_STREAMS = 4;
export const RANGED_PUSH_STREAMS_CAP = 8;
export const RANGED_PUSH_CHUNK_BYTES = 4 * 1024 * 1024;

export function rangedPushPlan(input: {
  capabilities: readonly string[];
  streams?: number;
  chunkBytes?: number;
}): { streams: number; maxRangeBytes?: number; ranged: boolean } {
  const ranged = input.capabilities.includes('staged-package-ranged');
  if (!ranged) return { streams: 1, ranged: false };
  const requested = input.streams ?? RANGED_PUSH_STREAMS;
  const streams = Math.min(Math.max(1, requested), RANGED_PUSH_STREAMS_CAP);
  return { streams, maxRangeBytes: input.chunkBytes ?? RANGED_PUSH_CHUNK_BYTES, ranged: true };
}

/** 交签名清单的超时：一个几百字节的 POST，慢到这个份上说明链路已经不行了。 */
const MANIFEST_TIMEOUT_MS = 60 * 1000;

/** 回包读流的上限与时限：正常都是几百字节的 JSON，超出必是对端在拖或在灌。 */
export const UPSTREAM_BODY_MAX_BYTES = 64 * 1024;
export const UPSTREAM_BODY_TIMEOUT_MS = 30 * 1000;

/** 作业跑在原请求之外，只带鉴权必需的头，避免把已关闭请求的 body / signal 拖进来。 */
export function detachRequest(req: Request): Request {
  const headers = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const origin = req.headers.get('origin');
  if (origin) headers.set('origin', origin);
  return new Request(req.url, { headers });
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 有界地读完一个回包：超时或超量都立刻取消读流。
 * `withTimeout()` 只管到拿到 Response 为止——对端把头发完再把 body 挂住，
 * 就能让整个升级作业永远停在这里（还占着发行包缓存租约）；灌一个超大 body 同样吃内存。
 */
export async function consumeBoundedBody(
  res: Response,
  opts: { limitBytes?: number; timeoutMs?: number } = {}
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const limitBytes = opts.limitBytes ?? UPSTREAM_BODY_MAX_BYTES;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(
      () => resolve('expired'),
      Math.max(0, opts.timeoutMs ?? UPSTREAM_BODY_TIMEOUT_MS)
    );
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === 'expired') break;
      if (next.done) {
        completed = true;
        break;
      }
      const value = next.value;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > limitBytes) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // 读流失败按空体处理：调用方只拿它做诊断
  } finally {
    if (timer) clearTimeout(timer);
    // 正常读完不取消：取消一条已经关掉的流会被转发层当成 aborted。
    if (!completed) await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

/** 把上游回包压成一行可读结论：优先 `code` / `error` 字段，拿不到就用原文。 */
export async function describeUpstream(res: Response, timeoutMs?: number): Promise<string> {
  const text = (await consumeBoundedBody(res, { timeoutMs })).slice(0, 800);
  let extra = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const code = (parsed as { code?: unknown }).code;
      const error = (parsed as { error?: unknown }).error;
      extra = [typeof code === 'string' ? code : null, typeof error === 'string' ? error : null]
        .filter(Boolean)
        .join(' ');
    }
  } catch {
    // keep raw text
  }
  return `HTTP ${res.status}${extra ? ` ${extra}` : ''}`.trim();
}

/**
 * 推字节之前先把「SHA256SUMS + 签名」交给目标，让它自己验一遍并记下权威摘要。
 * 目标 404 表示是没有这个接口的老节点，按老流程继续（老节点本来也只认自报 sha256）。
 */
export async function pushPackageManifest(input: {
  forward: AuthorizedUpgradeForward;
  req: Request;
  nodeId: string;
  version: string;
  sums: string;
  sig: string;
  /** 推的是哪一份资产：目标按这个名字从 SHA256SUMS 取摘要，两边必须一致。 */
  asset: string;
  signal: AbortSignal;
  /** 整个来回（含读回包）的预算；缺省 `MANIFEST_TIMEOUT_MS`，单测用来把它压短。 */
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + (input.timeoutMs ?? MANIFEST_TIMEOUT_MS);
  try {
    const res = await withTimeout(
      input.forward.forwardAuthorizedHttp(input.req, {
        nodeId: input.nodeId,
        method: 'POST',
        path: '/api/system/upgrade/package/manifest',
        body: {
          version: input.version,
          sums: input.sums,
          sig: input.sig,
          asset: input.asset,
        },
        signal: input.signal,
        retry: { attempts: 2 },
      }),
      Math.max(1, deadline - Date.now()),
      'manifest timeout'
    );
    // 同一条预算继续管读回包：头到了不等于对端会把 body 发完。
    const remaining = Math.max(0, deadline - Date.now());
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
      await consumeBoundedBody(res, { timeoutMs: remaining });
      return { ok: true };
    }
    return { ok: false, error: `manifest failed: ${await describeUpstream(res, remaining)}` };
  } catch (err) {
    return { ok: false, error: `manifest failed: ${errorMessage(err)}` };
  }
}

export function releaseCacheDir(): string {
  return resolveReleaseCacheDir(resolveUpgradeInstallDir(getInstallInfo()));
}

export async function defaultReleaseDownload(
  version: string,
  signal?: AbortSignal,
  onProgress?: DownloadProgressFn,
  assetName?: string
): Promise<{ path: string; sha256: string; bytes: number; sums: string; sig: string | null }> {
  return downloadVerifiedRelease(version, {
    cacheDir: releaseCacheDir(),
    signal,
    onProgress,
    assetName,
  });
}

/** 拼 `PUT /api/system/upgrade/package` 的查询串。ranged 必带 offset/length/total。 */
export function pushPackageQuery(input: {
  version: string;
  sha256: string;
  offset: number;
  length: number;
  total: number;
  ranged: boolean;
}): string {
  const q = new URLSearchParams();
  q.set('version', input.version);
  q.set('sha256', input.sha256);
  if (input.ranged) {
    q.set('offset', String(input.offset));
    q.set('length', String(input.length));
    q.set('total', String(input.total));
  } else if (input.offset > 0) {
    q.set('offset', String(input.offset));
  }
  return `?${q.toString()}`;
}

export function parseStagedStatusBody(
  text: string,
  totalBytes: number
): { offset: number; complete: boolean; ranges: Array<{ offset: number; length: number }> } {
  const empty = {
    offset: 0,
    complete: false,
    ranges: [] as Array<{ offset: number; length: number }>,
  };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return empty;
    const row = parsed as { receivedBytes?: unknown; complete?: unknown; ranges?: unknown };
    const ranges = rangesFromPairs(row.ranges);
    if (row.complete === true) {
      return {
        offset: totalBytes,
        complete: true,
        ranges: totalBytes > 0 ? [{ offset: 0, length: totalBytes }] : [],
      };
    }
    const received = typeof row.receivedBytes === 'number' ? row.receivedBytes : 0;
    if (!Number.isFinite(received) || received < 0) return empty;
    return {
      offset: Math.min(Math.trunc(received), totalBytes),
      complete: false,
      ranges,
    };
  } catch {
    return empty;
  }
}

export function retryablePushStatus(status: number, detail: string): boolean {
  if (detail.includes('UPGRADE_OFFSET_MISMATCH')) return true;
  return status >= 500;
}

export async function classifyUpgradePushResponse(
  pushed: Response,
  ctx: { cancelled: boolean; aborted: boolean }
): Promise<PushOutcome> {
  if (ctx.cancelled) {
    await consumeBoundedBody(pushed);
    return { kind: 'cancelled' };
  }
  if (pushed.status >= 200 && pushed.status < 300) {
    // 小 JSON 回包读完再走，`body.cancel()` 会给转发层一个假的 aborted 结论。
    await consumeBoundedBody(pushed);
    return { kind: 'landed' };
  }
  if (ctx.aborted) {
    await consumeBoundedBody(pushed);
    return { kind: 'cancelled' };
  }
  const detail = await describeUpstream(pushed);
  const error = `push failed: ${detail}`;
  return retryablePushStatus(pushed.status, detail)
    ? { kind: 'retry', error }
    : { kind: 'fail', error };
}

export async function deleteStagedBestEffort(input: {
  nodeId: string;
  version: string;
  req: Request;
  forward: AuthorizedUpgradeForward;
}): Promise<void> {
  try {
    const res = await input.forward.forwardAuthorizedHttp(input.req, {
      nodeId: input.nodeId,
      method: 'DELETE',
      path: '/api/system/upgrade/package',
      query: `?version=${encodeURIComponent(input.version)}`,
      retry: { attempts: 2 },
    });
    await consumeBoundedBody(res);
    if (res.status < 200 || res.status >= 300) {
      console.warn(
        `[mesh][upgrade] cancel staged package failed node=${input.nodeId} version=${input.version} status=${res.status}`
      );
    }
  } catch (err) {
    const detail = errorMessage(err);
    console.warn(
      `[mesh][upgrade] cancel staged package failed node=${input.nodeId} version=${input.version} err=${detail}`
    );
  }
}
