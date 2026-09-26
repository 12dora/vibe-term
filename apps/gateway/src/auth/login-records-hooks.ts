import type { LoginRecordMethod, LoginRecordSecond } from '@vibeterm/shared';
import { MIN_LOGIN_RECORDS_VERSION } from '@vibeterm/shared';
import { parseIpLiteral } from '../mesh/address-class';
import { loginLimiterIp } from '../mesh/auth-login-ip';
import { getMeshRequestContext } from '../mesh/mesh-deps';
import { nodeVersionMeets } from '../mesh/node-version';
import {
  loginRecordIp,
  loginRecordKind,
  loginRecordViaNodeId,
  readLoginClient,
  readLoginOrigin,
  readLoginUserAgent,
  secondFromFailureCode,
} from './login-records-meta';
import { peekLoginRecordService, warnLoginRecord } from './login-records-service';
import type { NewLoginRecord } from './login-records-store';

export type LoginRecorderEnv = {
  nodeId: string;
  lookupUser: (uid: string) => { id: string; username: string } | null;
  peerVersion?: (nodeId: string) => string | null;
};

const LIMITER_ROW_INTERVAL_MS = 60_000;
const LIMITER_ROW_MAX = 10_000;
const limiterRows = new Map<string, number>();

/** 凭据类失败按限流桶键每分钟最多落这么多行，避免一次洪水冲掉更早的失败记录。 */
export const CREDENTIAL_FAILURE_ROWS_PER_MINUTE = 6;
const CREDENTIAL_ROW_WINDOW_MS = 60_000;
const CREDENTIAL_ROW_MAX_KEYS = 10_000;
const credentialRows = new Map<string, number[]>();

let rowClock: () => number = () => Date.now();

export function setLimiterRowClock(clock: () => number): void {
  rowClock = clock;
}

export function resetLimiterRowThrottle(): void {
  limiterRows.clear();
  credentialRows.clear();
  rowClock = () => Date.now();
}

export type LoginLimiterReject = {
  uid: string;
  code: string;
  status: number;
  ip: string;
  req: Request;
  method?: LoginRecordMethod | null;
};

export type ForwardedAuthRejected = {
  req: Request;
  entryNodeId: string;
  targetNodeId: string;
  uid: string;
  ip: string;
  code: string;
};

let env: LoginRecorderEnv | null = null;

export function bindLoginRecorderEnv(next: LoginRecorderEnv | null): void {
  env = next;
}

export function bindLoginHooks<T>(deps: {
  nodeId: string;
  userStore: {
    getById(id: string): { id: string; username: string } | null;
    getByUsername(name: string): { id: string; username: string } | null;
    getNode?(id: string): { version?: string | null } | null;
    getPeer?(id: string): { version?: string | null } | null;
  };
  onLimiterReject?: T;
}): T | undefined {
  bindLoginRecorderEnv({
    nodeId: deps.nodeId,
    lookupUser: (uid) => deps.userStore.getById(uid) ?? deps.userStore.getByUsername(uid),
    peerVersion: (nodeId) => knownPeerVersion(deps.userStore, nodeId),
  });
  return deps.onLimiterReject;
}

export function loginRecorderEnv(): LoginRecorderEnv | null {
  return env;
}

export function recordAuthLoginSuccess(fields: {
  uid: string;
  via: string;
  method: string;
  second: LoginRecordSecond;
  origin: string;
  req?: Request;
}): void {
  const nodeId = env?.nodeId ?? '';
  const who = identityFor(fields.uid);
  const req = fields.req;
  safeWrite({
    outcome: 'success',
    uid: who.uid,
    username: who.username,
    method: pickMethod(fields.method),
    second: fields.second,
    client: req ? readLoginClient(req) : 'unknown',
    kind: loginRecordKind(fields.via, nodeId),
    viaNodeId: loginRecordViaNodeId(fields.via, nodeId),
    targetNodeId: nodeId || null,
    ip: req ? recordedIp(req) : null,
    userAgent: req ? readLoginUserAgent(req) : null,
    origin: fields.origin,
    code: null,
  });
}

export function recordAuthLoginFailure(input: {
  uid: string;
  code: string;
  req: Request;
  method: LoginRecordMethod | null;
}): void {
  if (skipFailureCode(input.code) || isLimiterCode(input.code)) return;
  const nodeId = env?.nodeId ?? '';
  const via = getMeshRequestContext(input.req).via;
  const who = identityFor(input.uid);
  if (!allowCredentialRow(credentialRowKey(input.req, who.uid))) return;
  safeWrite({
    outcome: 'failed',
    uid: who.uid,
    username: who.username,
    method: input.method,
    second: secondFromFailureCode(input.code),
    client: readLoginClient(input.req),
    kind: loginRecordKind(via, nodeId),
    viaNodeId: loginRecordViaNodeId(via, nodeId),
    targetNodeId: nodeId || null,
    ip: recordedIp(input.req),
    userAgent: readLoginUserAgent(input.req),
    origin: readLoginOrigin(input.req),
    code: input.code,
  });
}

export function recordLimiterRejection(info: LoginLimiterReject): void {
  const nodeId = env?.nodeId ?? '';
  const via = getMeshRequestContext(info.req).via;
  const who = identityFor(info.uid);
  const ip = recordedIp(info.req) ?? parseIpLiteral(info.ip) ?? null;
  if (!allowLimiterRow(limiterRowKey(info.code, ip, who.uid))) return;
  safeWrite({
    outcome: 'failed',
    uid: who.uid,
    username: who.username,
    method: info.method ?? null,
    second: null,
    client: readLoginClient(info.req),
    kind: loginRecordKind(via, nodeId),
    viaNodeId: loginRecordViaNodeId(via, nodeId),
    targetNodeId: nodeId || null,
    ip,
    userAgent: readLoginUserAgent(info.req),
    origin: readLoginOrigin(info.req),
    code: info.code,
  });
}

export function recordForwardedAuthRejected(info: ForwardedAuthRejected): void {
  const who = identityFor(info.uid);
  const ip = parseIpLiteral(info.ip) ?? recordedIp(info.req);
  if (!allowLimiterRow(limiterRowKey(info.code || 'RATE_LIMITED', ip, who.uid))) return;
  safeWrite({
    outcome: 'failed',
    uid: who.uid,
    username: who.username,
    method: null,
    second: null,
    client: readLoginClient(info.req),
    kind: 'interactive',
    viaNodeId: info.entryNodeId || null,
    targetNodeId: info.targetNodeId || null,
    ip,
    userAgent: readLoginUserAgent(info.req),
    origin: readLoginOrigin(info.req),
    code: info.code || 'RATE_LIMITED',
  });
}

export function noteAuthLoginFailure(input: {
  uid: string;
  code: string;
  status?: number;
  ip: string;
  req: Request;
  method: LoginRecordMethod | null;
  onLimiterReject?: (info: LoginLimiterReject) => void;
}): void {
  try {
    if (skipFailureCode(input.code)) return;
    if (isLimiterCode(input.code)) {
      const info: LoginLimiterReject = {
        uid: input.uid,
        code: input.code,
        status: input.status ?? 429,
        ip: input.ip,
        req: input.req,
        method: input.method,
      };
      recordLimiterRejection(info);
      const hook = input.onLimiterReject;
      if (hook && hook !== recordLimiterRejection) hook(info);
      return;
    }
    recordAuthLoginFailure(input);
  } catch (err) {
    warnLoginRecord(err);
  }
}

function safeWrite(row: NewLoginRecord): void {
  try {
    peekLoginRecordService()?.record(row);
  } catch (err) {
    warnLoginRecord(err);
  }
}

function identityFor(uid: string): { uid: string | null; username: string | null } {
  const hint = uid.trim();
  if (!hint) return { uid: null, username: null };
  try {
    const user = env?.lookupUser(hint) ?? null;
    if (!user) return { uid: hint, username: null };
    return { uid: user.id, username: user.username || null };
  } catch {
    return { uid: hint, username: null };
  }
}

function pickMethod(method: string): LoginRecordMethod | null {
  if (method === 'root' || method === 'passkey') return method;
  return null;
}

function skipFailureCode(code: string): boolean {
  return code === 'TOTP_REQUIRED' || code === 'PASSKEY_REQUIRED';
}

function isLimiterCode(code: string): boolean {
  return code === 'RATE_LIMITED' || code === 'PASSWORD_LOGIN_PAUSED';
}

function recordedIp(req: Request): string | null {
  const via = getMeshRequestContext(req).via;
  return loginRecordIp(req, entryIpTrusted(via));
}

function entryIpTrusted(via: string | null | undefined): boolean {
  if (!via) return false;
  const version = env?.peerVersion?.(via) ?? null;
  return nodeVersionMeets(version, MIN_LOGIN_RECORDS_VERSION);
}

function knownPeerVersion(
  userStore: {
    getNode?(id: string): { version?: string | null } | null;
    getPeer?(id: string): { version?: string | null } | null;
  },
  nodeId: string
): string | null {
  const known = [userStore.getNode?.(nodeId)?.version, userStore.getPeer?.(nodeId)?.version].filter(
    (version): version is string => typeof version === 'string' && version.trim() !== ''
  );
  if (known.length === 0) return null;
  if (!known.every((version) => nodeVersionMeets(version, MIN_LOGIN_RECORDS_VERSION))) return null;
  return known[0] ?? null;
}

function limiterRowKey(code: string, ip: string | null, uid: string | null): string {
  if (code === 'PASSWORD_LOGIN_PAUSED') return `acct:${uid || ip || 'unknown'}`;
  return `ip:${ip || uid || 'unknown'}`;
}

function credentialRowKey(req: Request, uid: string | null): string {
  return `${loginLimiterIp(req)}\0${uid ?? ''}`;
}

function allowCredentialRow(key: string): boolean {
  const now = rowClock();
  const live = freshHits(credentialRows.get(key), now);
  if (live.length >= CREDENTIAL_FAILURE_ROWS_PER_MINUTE) {
    const stored = credentialRows.get(key);
    if (stored && stored.length !== live.length) credentialRows.set(key, live);
    return false;
  }
  live.push(now);
  credentialRows.delete(key);
  if (credentialRows.size >= CREDENTIAL_ROW_MAX_KEYS) {
    const oldest = credentialRows.keys().next().value as string | undefined;
    if (oldest !== undefined) credentialRows.delete(oldest);
  }
  credentialRows.set(key, live);
  return true;
}

function freshHits(hits: number[] | undefined, now: number): number[] {
  if (!hits) return [];
  const cutoff = now - CREDENTIAL_ROW_WINDOW_MS;
  let start = 0;
  while (start < hits.length && (hits[start] ?? 0) <= cutoff) start += 1;
  return start === 0 ? hits.slice() : hits.slice(start);
}

function allowLimiterRow(key: string): boolean {
  const now = rowClock();
  const prev = limiterRows.get(key);
  if (prev !== undefined && now - prev < LIMITER_ROW_INTERVAL_MS) return false;
  limiterRows.delete(key);
  if (limiterRows.size >= LIMITER_ROW_MAX) {
    const oldest = limiterRows.keys().next().value as string | undefined;
    if (oldest !== undefined) limiterRows.delete(oldest);
  }
  limiterRows.set(key, now);
  return true;
}
