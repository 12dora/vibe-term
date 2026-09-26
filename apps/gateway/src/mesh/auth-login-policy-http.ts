import {
  type LoginPolicy,
  MIN_LOGIN_POLICY_RECORD_VERSION,
  standardLoginPolicy,
} from '@vibeterm/shared/auth';
import { decodeBase64url, decodeDelegation } from '@vibeterm/shared/auth';
import { recordLimiterRejection } from '../auth/login-records-hooks';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { type LoginFailureSink, createLoginFailureSink } from './auth-key-log-login';
import type {
  LoginLimitAttempt,
  LoginLimitHit,
  LoginLimiterRejectInfo,
  LoginMethod,
  LoginPolicyLimiter,
} from './auth-login-limiter';

export type { LoginMethod };
import { loginIpExempt, loginLimiterIp } from './auth-login-ip';
import { findPrimaryUser } from './auth-mode-cache';
import { isPeerRequest } from './client-source';
import { nodesBlockingMinVersion } from './key-log-compat';
import { AUTH_UID_MAX_BYTES } from './mesh-deps';
import { jsonBody, jsonError } from './session-middleware';

export function peekLoginMethod(body: Record<string, unknown>): LoginMethod {
  try {
    if (typeof body.delegation !== 'string') return null;
    const method = decodeDelegation(decodeBase64url(body.delegation)).method;
    if (method === 'root' || method === 'passkey') return method;
    return null;
  } catch {
    return null;
  }
}

export function currentLoginPolicy(
  userStore: UserStore,
  keyLog: UserKeyService,
  primaryUserId?: string
): LoginPolicy {
  const user = findPrimaryUser(userStore, primaryUserId);
  if (!user) return standardLoginPolicy();
  try {
    return keyLog.readLoginPolicy(user.id) ?? standardLoginPolicy();
  } catch {
    return standardLoginPolicy();
  }
}

export { loginLimiterIp };

export function respondToLoginLimit(input: LoginLimitInput): Response | null {
  const hit = takeLoginLimit(input);
  if (!hit) return null;
  return jsonError(hit.code, 429, { retryAfterMs: hit.retryAfterMs });
}

export function attachLoginLimiter(host: {
  limiter: LoginPolicyLimiter;
  policy: () => LoginPolicy;
  onReject: () => ((info: LoginLimiterRejectInfo) => void) | undefined;
  peekUid: (body: Record<string, unknown>) => string;
  uidTooLong: (uid: string) => boolean;
  canonicalUid?: (uid: string) => string;
}): {
  openSink(req: Request, ctx: { peer: boolean; ip: string }): LoginFailureSink;
  gate(req: Request, uidHint: string, ip: string, method: LoginMethod): Response | null;
  record(req: Request, uidHint: string, ip: string): void;
} {
  const input = (
    req: Request,
    uidHint: string,
    ip: string,
    method: LoginMethod,
    peer: boolean
  ): LoginLimitInput => ({
    limiter: host.limiter,
    policy: host.policy(),
    req,
    uidHint,
    ip,
    method,
    peer,
    onReject: host.onReject(),
    canonicalUid: host.canonicalUid,
  });
  return {
    openSink: (req, ctx) =>
      openLoginSink({
        ...input(req, '', ctx.ip, null, ctx.peer),
        ctx,
        peekUid: host.peekUid,
        uidTooLong: host.uidTooLong,
      }),
    gate: (req, uidHint, ip, method) =>
      respondToLoginLimit({
        ...input(req, uidHint, ip, method, false),
        countAccount: false,
        recordRejection: false,
      }),
    record: (req, uidHint, ip) =>
      recordLoginLimitFailure({
        ...input(req, uidHint, ip, null, false),
        countAccount: false,
      }),
  };
}

export function openLoginSink(
  input: LoginLimitInput & {
    ctx: { peer: boolean; ip: string };
    peekUid: (body: Record<string, unknown>) => string;
    uidTooLong: (uid: string) => boolean;
  }
): LoginFailureSink {
  let method: LoginMethod = input.method;
  return createLoginFailureSink(
    {
      recordFailure: (uidHint) => {
        recordLoginLimitFailure({ ...input, uidHint, method });
      },
      loginLimited: (uidHint) => takeLoginLimit({ ...input, uidHint, method }),
      peekUid: input.peekUid,
      uidTooLong: input.uidTooLong,
      noteMethod: (body) => {
        method = peekLoginMethod(body);
      },
    },
    input.ctx
  );
}

type LoginLimitInput = {
  limiter: LoginPolicyLimiter;
  policy: LoginPolicy;
  req: Request;
  uidHint: string;
  ip: string;
  method: LoginMethod;
  peer: boolean;
  onReject?: (info: LoginLimiterRejectInfo) => void;
  canonicalUid?: (uid: string) => string;
  /** 入口只计 IP。目标与直连登录计入解析后的 uid。 */
  countAccount?: boolean;
  /** 入口 429 由 `recordEntryLogin429` 单独落一行。 */
  recordRejection?: boolean;
};

function takeLoginLimit(input: LoginLimitInput): LoginLimitHit | null {
  const hit = input.limiter.check(limitAttempt(input));
  if (!hit) return null;
  const info = {
    ...hit,
    uid: input.uidHint,
    ip: input.ip,
    method: input.method,
    peer: input.peer,
  };
  input.onReject?.(info);
  if (input.recordRejection !== false) {
    recordLimiterRejection({
      uid: info.uid,
      code: info.code,
      status: 429,
      ip: info.ip,
      req: input.req,
      method: info.method,
    });
  }
  return hit;
}

export function recordLoginLimitFailure(
  input: LoginLimitInput & { uidHint: string; method: LoginMethod }
): void {
  if (input.uidHint && uidTooLong(input.uidHint)) return;
  input.limiter.recordFailure(limitAttempt(input));
}

export function handleLoginPolicyRequest(
  uid: string | null,
  deps: { userStore: UserStore; keyLogService: UserKeyService; nodeId: string }
): Response {
  if (!uid) return jsonError('UNAUTHORIZED', 401);
  const stored = storedLoginPolicy(deps.keyLogService, uid);
  const blockers = loginPolicyBlockers(deps, uid);
  return jsonBody({
    policy: stored.policy,
    source: stored.source,
    writable: blockers.length === 0,
    blockers,
  });
}

function limitAttempt(input: LoginLimitInput): LoginLimitAttempt {
  const peer = input.peer || isPeerRequest(input.req);
  const countAccount = input.countAccount !== false;
  const hinted = input.uidHint.trim();
  const uid = !countAccount ? '' : hinted ? (input.canonicalUid?.(hinted) ?? hinted) : '';
  return {
    ip: peer ? '' : loginLimiterIp(input.req),
    uid,
    method: input.method,
    exempt: loginIpExempt(input.policy, input.req),
    countAccount,
    policy: input.policy,
  };
}

function storedLoginPolicy(
  keyLog: UserKeyService,
  uid: string
): { policy: LoginPolicy; source: 'default' | 'keylog' } {
  try {
    const policy = keyLog.readLoginPolicy(uid);
    if (!policy) return { policy: standardLoginPolicy(), source: 'default' };
    return { policy, source: 'keylog' };
  } catch {
    return { policy: standardLoginPolicy(), source: 'default' };
  }
}

function loginPolicyBlockers(
  deps: { userStore: UserStore; keyLogService: UserKeyService; nodeId: string },
  uid: string
) {
  return nodesBlockingMinVersion(deps.userStore, MIN_LOGIN_POLICY_RECORD_VERSION, uid, {
    relayMode: relayModeOf(deps.keyLogService, uid),
    localNodeId: deps.nodeId,
    failClosedUncached: true,
  }).map((node) => ({
    nodeId: node.id,
    name: node.name,
    version: node.version,
  }));
}

const uidEncoder = new TextEncoder();

function uidTooLong(uid: string): boolean {
  return uidEncoder.encode(uid).byteLength > AUTH_UID_MAX_BYTES;
}

function relayModeOf(keyLog: UserKeyService, uid: string): boolean {
  try {
    return (keyLog.currentState(uid).relays?.relays.length ?? 0) > 0;
  } catch {
    return false;
  }
}
