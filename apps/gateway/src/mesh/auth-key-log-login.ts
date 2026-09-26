import type { LoginRecordMethod } from '@vibeterm/shared';
import { noteAuthLoginFailure } from '../auth/login-records-hooks';
import { peekLoginMethod } from '../auth/login-records-meta';
import { logAuthLoginFailed } from './auth-audit-log';
import type { LoginLimitHit } from './auth-login-limiter';
import { clientIpFromRequest } from './client-ip';
import { isPeerRequest } from './client-source';
import { jsonError } from './session-middleware';

export type LoginFailureSink = {
  noteUidHint: (uid: string) => void;
  fail: (code: string, status?: number, logCode?: string) => Response;
  precheck: (body: Record<string, unknown> | null) => Response | null;
  rejectUid: () => Response | null;
};

const loginCtxRequest = new WeakMap<object, Request>();

export function loginRequestContext(req: Request): { peer: boolean; ip: string } {
  const peer = isPeerRequest(req);
  // 入口 forwarder 会丢掉 x-forwarded-* / CF-Connecting-IP，目标节点看到的是
  // `peer:<入口>`。对端自带的转发头也不可信（成员节点可伪造），因此转发登录的
  // IP 桶留空，只按 uid 计；真实客户端 IP 的限速在入口执行。
  const ip = peer ? '' : (clientIpFromRequest(req) ?? 'local');
  const ctx = { peer, ip };
  loginCtxRequest.set(ctx, req);
  return ctx;
}

export function createLoginFailureSink(
  deps: {
    recordFailure: (uidHint: string) => void;
    /** 已锁定时返回命中（调用方负责 `onLimiterReject`）。未锁定返回 null。 */
    loginLimited: (uidHint: string) => LoginLimitHit | null;
    peekUid: (body: Record<string, unknown>) => string;
    uidTooLong: (uid: string) => boolean;
    noteMethod?: (body: Record<string, unknown>) => void;
  },
  ctx: { peer: boolean; ip: string }
): LoginFailureSink {
  const { ip } = ctx;
  let uidHint = '';
  let method: LoginRecordMethod | null = null;
  const noteUidHint = (uid: string) => {
    uidHint = uid;
  };
  const fail = (code: string, status?: number, logCode?: string): Response => {
    logAuthLoginFailed({ uid: uidHint, code: logCode ?? code, ip });
    rememberLoginFailure(ctx, uidHint, code, status, method);
    if (code === 'RATE_LIMITED' || code === 'PASSWORD_LOGIN_PAUSED') {
      return jsonError(code, status ?? 429);
    }
    if (code !== 'TOTP_REQUIRED' && code !== 'PASSKEY_REQUIRED') deps.recordFailure(uidHint);
    return jsonError(code, status ?? 401);
  };
  const rejectUid = (): Response | null => {
    if (uidHint && deps.uidTooLong(uidHint)) {
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      rememberLoginFailure(ctx, uidHint, 'MALFORMED', 400, method);
      return jsonError('MALFORMED', 400);
    }
    const hit = deps.loginLimited(uidHint);
    if (!hit) return null;
    logAuthLoginFailed({ uid: uidHint, code: hit.code, ip });
    return jsonError(hit.code, 429, { retryAfterMs: hit.retryAfterMs });
  };
  const precheck = (body: Record<string, unknown> | null): Response | null => {
    if (!body) {
      deps.recordFailure('');
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      rememberLoginFailure(ctx, uidHint, 'MALFORMED', 400, null);
      return jsonError('MALFORMED', 400);
    }
    method = peekLoginMethod(body);
    deps.noteMethod?.(body);
    noteUidHint(deps.peekUid(body));
    return rejectUid();
  };
  return { noteUidHint, fail, precheck, rejectUid };
}

function rememberLoginFailure(
  ctx: { peer: boolean; ip: string },
  uid: string,
  code: string,
  status: number | undefined,
  method: LoginRecordMethod | null
): void {
  const req = loginCtxRequest.get(ctx);
  if (!req) return;
  noteAuthLoginFailure({ uid, code, status, ip: ctx.ip, req, method });
}
