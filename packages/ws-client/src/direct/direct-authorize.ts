// 直连协商的两条转发 REST：换 connectionId、authorize。失败按 body 里的 code 分流：
// 等 primary（404/409）、目标给不出直连（DIRECT_UNAVAILABLE，整段停放）、目标这次没给出
// （DIRECT_BUSY / 老 node 带一过性 reason 的 DIRECT_UNAVAILABLE，守 retryAfterMs）、
// 链路打不通（NODE_UNREACHABLE）、其余 5xx 退避、4xx 不重试。
// 这里只**分类**，不记账：熔断由控制器按错误上的 `kind` 统一记一次。

import { CONNECTION_HEADER, assignHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import {
  AUTHORIZE_UNAVAILABLE_KIND,
  DIRECT_BUSY_KIND,
  DIRECT_UNAVAILABLE_KIND,
  NODE_UNREACHABLE_KIND,
} from './direct-breaker';
import {
  DirectAuthorizeError,
  type ErrorBody,
  NODE_UNREACHABLE_CODE,
  classifyDirectAuthorizeFailure,
  readErrorBody,
  throwIfPrimaryWaitCode,
} from './direct-carrier-errors';
import type { DtlsFingerprint } from './fingerprint';
import type { DirectApiClientLike, RtcAuthorizeResponse } from './rtc-types';

export const RTC_AUTHORIZE_PATH = '/api/rtc/authorize';
export const MESH_CONNECTION_PATH = '/api/mesh/connection';

/** `GET /api/mesh/connection`：带上本条 WS 的 client nonce，node 据此答出**服务端** id。 */
export function meshConnectionPath(cid?: string | null): string {
  return cid ? `${MESH_CONNECTION_PATH}?cid=${encodeURIComponent(cid)}` : MESH_CONNECTION_PATH;
}

export interface DirectRestContext {
  apiClient: DirectApiClientLike;
  signal: AbortSignal;
}

function describeFailure(
  label: string,
  status: number,
  code: string,
  reason: string | null = null
): string {
  const detail = [code, reason].filter(Boolean).join(' ');
  return `${label} failed (${status}${detail ? ` ${detail}` : ''})`;
}

/** 转发层 / 目标 node 的 5xx 归到哪一种熔断记账。 */
function serverFailureKind(failure: ErrorBody): string {
  const verdict = classifyDirectAuthorizeFailure(failure.code, failure.reason);
  if (verdict === 'unavailable') return DIRECT_UNAVAILABLE_KIND;
  if (verdict === 'busy') return DIRECT_BUSY_KIND;
  return failure.code === NODE_UNREACHABLE_CODE
    ? NODE_UNREACHABLE_KIND
    : AUTHORIZE_UNAVAILABLE_KIND;
}

/**
 * 非 2xx 时：`NO_CONNECTION` / `MULTIPLE_CONNECTIONS` 转成等待，`NODE_UNREACHABLE` 计入熔断后
 * 退避重试，其余 5xx 退避重试，其余（老 node 上该路由返回的 405 等）退化成不带 connectionId
 * 的旧行为——单连接时 node 侧照样能唯一定位。
 */
export async function lookupConnectionId(
  ctx: DirectRestContext,
  cid: string | null | undefined
): Promise<string | null> {
  let res: Response;
  try {
    res = await ctx.apiClient.fetch(meshConnectionPath(cid), { signal: ctx.signal });
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    throw new DirectAuthorizeError(`connection lookup failed${detail}`, false);
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { connectionId?: unknown } | null;
    if (typeof body?.connectionId === 'string' && body.connectionId) return body.connectionId;
    throw new DirectAuthorizeError('connection lookup response malformed', true);
  }
  const { code, reason } = await readErrorBody(res);
  throwIfPrimaryWaitCode(res.status, code, 'connection lookup');
  if (res.status < 500) return null;
  throw new DirectAuthorizeError(
    describeFailure('connection lookup', res.status, code),
    false,
    code,
    code === NODE_UNREACHABLE_CODE ? NODE_UNREACHABLE_KIND : 'lookup',
    null,
    reason
  );
}

export interface AuthorizeInput {
  rtcSession: string;
  connectionId: string | null;
  fpBrowser: DtlsFingerprint;
}

export async function requestAuthorize(
  ctx: DirectRestContext,
  input: AuthorizeInput
): Promise<{ nonce: string; fpNode: DtlsFingerprint }> {
  const { connectionId } = input;
  const res = await ctx.apiClient.fetch(RTC_AUTHORIZE_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connectionId ? assignHeaderPair({}, CONNECTION_HEADER, connectionId) : {}),
    },
    body: JSON.stringify({
      rtcSession: input.rtcSession,
      fp_browser: input.fpBrowser,
      ...(connectionId ? { connectionId } : {}),
    }),
    signal: ctx.signal,
  });
  if (!res.ok) {
    const failure = await readErrorBody(res);
    // connectionId 在 GET 与 authorize 之间失效（primary 重连 / 又开了一个标签页）：
    // 这不是配置错误，按「等 primary」处理，别当成 4xx 永久失败卡死在 failed。
    throwIfPrimaryWaitCode(res.status, failure.code, 'authorize');
    // 4xx 是配置/权限问题，重试没有意义；5xx 退避重试，由熔断限流。
    const server = res.status >= 500;
    throw new DirectAuthorizeError(
      describeFailure('authorize', res.status, failure.code, failure.reason),
      !server,
      failure.code,
      server ? serverFailureKind(failure) : 'authorization',
      server ? failure.retryAfterMs : null,
      failure.reason
    );
  }
  return parseAuthorizeGrant((await res.json()) as RtcAuthorizeResponse);
}

function parseAuthorizeGrant(body: RtcAuthorizeResponse): {
  nonce: string;
  fpNode: DtlsFingerprint;
} {
  const fp = body.fp_node as { algorithm?: unknown; value?: unknown } | undefined;
  if (
    typeof body.nonce !== 'string' ||
    typeof fp?.algorithm !== 'string' ||
    typeof fp?.value !== 'string'
  ) {
    throw new DirectAuthorizeError('authorize response malformed', true);
  }
  return { nonce: body.nonce, fpNode: { algorithm: fp.algorithm, value: fp.value } };
}
