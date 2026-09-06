// 远程升级作业的收发管道：请求脱壳、退避睡眠、上游错误摘要、交签名清单
//（包体读流已并入 `@vibeterm/transfer/node`）。都是与作业状态机无关的纯管道，
// 单独放一处让状态机文件只剩流程。

import { errorMessage, withTimeout } from '@vibeterm/shared';
import type { AuthorizedUpgradeForward } from './upgrade-service';

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
