import { logAuthLoginFailed } from './auth-audit-log';
import { clientIpFromRequest } from './client-ip';
import { isPeerRequest } from './client-source';
import { jsonError } from './session-middleware';

export type LoginFailureSink = {
  noteUidHint: (uid: string) => void;
  fail: (code: string, status?: number, logCode?: string) => Response;
  precheck: (body: Record<string, unknown> | null) => Response | null;
  rejectUid: () => Response | null;
};

export function loginRequestContext(req: Request): { peer: boolean; ip: string } {
  const peer = isPeerRequest(req);
  // 入口 forwarder 会丢掉 x-forwarded-* / CF-Connecting-IP，目标节点看到的是
  // `peer:<入口>`。对端自带的转发头也不可信（成员节点可伪造），因此转发登录的
  // IP 桶留空，只按 uid 计；真实客户端 IP 的限速在入口执行。
  const ip = peer ? '' : (clientIpFromRequest(req) ?? 'local');
  return { peer, ip };
}

export function createLoginFailureSink(
  deps: {
    recordFailure: (key: string) => void;
    loginLimited: (uidHint: string, ip: string) => boolean;
    peekUid: (body: Record<string, unknown>) => string;
    uidTooLong: (uid: string) => boolean;
  },
  ctx: { peer: boolean; ip: string }
): LoginFailureSink {
  const { ip } = ctx;
  let uidHint = '';
  const noteUidHint = (uid: string) => {
    uidHint = uid;
  };
  const fail = (code: string, status?: number, logCode?: string): Response => {
    logAuthLoginFailed({ uid: uidHint, code: logCode ?? code, ip });
    if (code === 'RATE_LIMITED') return jsonError(code, status ?? 429);
    if (code !== 'TOTP_REQUIRED' && code !== 'PASSKEY_REQUIRED') {
      if (ip) deps.recordFailure(`ip:${ip}`);
      if (uidHint) deps.recordFailure(`uid:${uidHint}`);
    }
    return jsonError(code, status ?? 401);
  };
  const rejectUid = (): Response | null => {
    if (uidHint && deps.uidTooLong(uidHint)) {
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      return jsonError('MALFORMED', 400);
    }
    if (deps.loginLimited(uidHint, ip)) {
      logAuthLoginFailed({ uid: uidHint, code: 'RATE_LIMITED', ip });
      return jsonError('RATE_LIMITED', 429);
    }
    return null;
  };
  const precheck = (body: Record<string, unknown> | null): Response | null => {
    if (!body) {
      if (ip) deps.recordFailure(`ip:${ip}`);
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      return jsonError('MALFORMED', 400);
    }
    noteUidHint(deps.peekUid(body));
    return rejectUid();
  };
  return { noteUidHint, fail, precheck, rejectUid };
}
