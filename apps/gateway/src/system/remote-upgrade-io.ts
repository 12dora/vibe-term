// 远程升级作业的收发管道：请求脱壳、退避睡眠、上游错误摘要、交签名清单
//（包体读流已并入 `@tmex/transfer/node`）。都是与作业状态机无关的纯管道，
// 单独放一处让状态机文件只剩流程。

import { errorMessage, withTimeout } from '@tmex/shared';
import type { AuthorizedUpgradeForward } from './upgrade-service';

/** 交签名清单的超时：一个几百字节的 POST，慢到这个份上说明链路已经不行了。 */
const MANIFEST_TIMEOUT_MS = 60 * 1000;

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

/** 把上游回包压成一行可读结论：优先 `code` / `error` 字段，拿不到就用原文。 */
export async function describeUpstream(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 800);
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
  signal: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await withTimeout(
      input.forward.forwardAuthorizedHttp(input.req, {
        nodeId: input.nodeId,
        method: 'POST',
        path: '/api/system/upgrade/package/manifest',
        body: { version: input.version, sums: input.sums, sig: input.sig },
        signal: input.signal,
        retry: { attempts: 2 },
      }),
      MANIFEST_TIMEOUT_MS,
      'manifest timeout'
    );
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
      await res.text().catch(() => '');
      return { ok: true };
    }
    return { ok: false, error: `manifest failed: ${await describeUpstream(res)}` };
  } catch (err) {
    return { ok: false, error: `manifest failed: ${errorMessage(err)}` };
  }
}
