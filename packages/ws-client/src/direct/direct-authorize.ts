// 直连协商的两条转发 REST：换 connectionId、authorize。失败按 body 里的 code 分流：
// 等 primary（404/409）、目标给不出直连（DIRECT_UNAVAILABLE，整段冷却）、链路打不通
// （NODE_UNREACHABLE，计入 authorize 熔断）、其余 5xx 退避、4xx 不重试。

import { CONNECTION_HEADER, assignHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import {
  noteAuthorizeFailure,
  noteAuthorizeSuccess,
  noteDirectUnavailable,
} from './direct-authorize-breaker';
import {
  DIRECT_UNAVAILABLE_CODE,
  DirectAuthorizeError,
  NODE_UNREACHABLE_CODE,
  readErrorCode,
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
  nodeId: string;
  now: () => number;
  signal: AbortSignal;
}

function describeFailure(label: string, status: number, code: string): string {
  return `${label} failed (${status}${code ? ` ${code}` : ''})`;
}

/** 转发层 / 目标 node 的 5xx 记账。 */
function noteServerFailure(ctx: DirectRestContext, code: string): void {
  if (code === DIRECT_UNAVAILABLE_CODE) {
    noteDirectUnavailable(ctx.nodeId, ctx.now());
    return;
  }
  const kind = code === NODE_UNREACHABLE_CODE ? 'node-unreachable' : 'authorize-unavailable';
  noteAuthorizeFailure(ctx.nodeId, ctx.now(), kind);
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
  const code = await readErrorCode(res);
  throwIfPrimaryWaitCode(res.status, code, 'connection lookup');
  if (res.status < 500) return null;
  if (code === NODE_UNREACHABLE_CODE) noteServerFailure(ctx, code);
  throw new DirectAuthorizeError(
    describeFailure('connection lookup', res.status, code),
    false,
    code
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
    const code = await readErrorCode(res);
    // connectionId 在 GET 与 authorize 之间失效（primary 重连 / 又开了一个标签页）：
    // 这不是配置错误，按「等 primary」处理，别当成 4xx 永久失败卡死在 failed。
    throwIfPrimaryWaitCode(res.status, code, 'authorize');
    // 4xx 是配置/权限问题，重试没有意义；5xx 退避重试，由 authorize 熔断限流。
    if (res.status >= 500) noteServerFailure(ctx, code);
    throw new DirectAuthorizeError(
      describeFailure('authorize', res.status, code),
      res.status < 500,
      code
    );
  }
  noteAuthorizeSuccess(ctx.nodeId);
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
