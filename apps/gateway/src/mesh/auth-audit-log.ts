import { isIP } from 'node:net';
import { type KeyLogEffect, bytesEqual } from '@vibeterm/shared/auth';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { AuthDb } from '../auth/types';
import { nodeSessions } from '../db/schema';
import { logLine } from './mesh-log';

export type AuthLoginSecond = 'totp' | 'passkey' | 'waived' | 'none';

const LOGIN_CLIENT: Record<string, string> = {
  challenge_mismatch: 'CHALLENGE_MISMATCH',
  target_mismatch: 'TARGET_MISMATCH',
  uid_mismatch: 'UID_MISMATCH',
  entry_mismatch: 'ENTRY_MISMATCH',
  bad_signature: 'INVALID_CREDENTIALS',
};

const LOGIN_LOG: Record<string, string> = {
  ...LOGIN_CLIENT,
  bad_signature: 'BAD_SIGNATURE',
};

const DELEGATION_CLIENT: Record<string, string> = {
  expired: 'DELEGATION_EXPIRED',
  bad_signature: 'INVALID_CREDENTIALS',
  method_mismatch: 'INVALID_CREDENTIALS',
  invalid_ttl: 'DELEGATION_INVALID_TTL',
  issued_in_future: 'DELEGATION_ISSUED_IN_FUTURE',
};

const DELEGATION_LOG: Record<string, string> = {
  expired: 'DELEGATION_EXPIRED',
  bad_signature: 'DELEGATION_BAD_SIGNATURE',
  method_mismatch: 'DELEGATION_METHOD_MISMATCH',
  invalid_ttl: 'DELEGATION_INVALID_TTL',
  issued_in_future: 'DELEGATION_ISSUED_IN_FUTURE',
};

export function loginFailCodes(error: string): { client: string; log: string } {
  return {
    client: LOGIN_CLIENT[error] ?? 'INVALID_CREDENTIALS',
    log: LOGIN_LOG[error] ?? error.toUpperCase(),
  };
}

export function delegationFailResult(error: string): { ok: false; code: string; log: string } {
  return {
    ok: false,
    code: DELEGATION_CLIENT[error] ?? 'INVALID_CREDENTIALS',
    log: DELEGATION_LOG[error] ?? error.toUpperCase(),
  };
}

export const DELEGATION_BAD_SIGNATURE_FAIL = {
  ok: false as const,
  code: 'DELEGATION_BAD_SIGNATURE',
  log: 'DELEGATION_BAD_SIGNATURE',
};

export function loginBindingError(
  login: { entry: string; target: string; target_pk: Uint8Array; uid: string },
  challenge: { entryNodeId: string; uid: string },
  nodeId: string,
  nodePk: Uint8Array,
  delegationUid: string,
  viaSelf: string
): string | null {
  // 本机入口的 challenge 记录哨兵 'self'；浏览器按 /api/auth/mode.nodeId 填真实 id，CLI 填 'self'，两者都算本机
  const selfEntry = challenge.entryNodeId === viaSelf && login.entry === nodeId;
  if (login.entry !== challenge.entryNodeId && !selfEntry) return 'ENTRY_MISMATCH';
  if (login.target !== nodeId && login.target !== viaSelf) return 'TARGET_MISMATCH';
  if (!bytesEqual(login.target_pk, nodePk)) return 'TARGET_MISMATCH';
  if (login.uid !== delegationUid || login.uid !== challenge.uid) return 'UID_MISMATCH';
  return null;
}

export function maskAuthClientIp(ip: string): string {
  const host = stripIpLiteral(ip);
  if (!host) return '-';
  if (host === 'local') return 'local';
  if (host.startsWith('peer:')) return 'peer';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped?.[1]) return `::ffff:${maskIpv4(mapped[1])}`;
  if (isIP(host) === 4) return maskIpv4(host);
  if (host.includes(':')) return maskIpv6Prefix48(host);
  return host;
}

export function resolveLoginSecond(input: {
  method: string;
  totpPresent: boolean;
  passkeyPresent: boolean;
  waived: boolean;
}): AuthLoginSecond {
  if (input.method !== 'root') return 'none';
  if (input.totpPresent) return 'totp';
  if (input.passkeyPresent) return 'passkey';
  if (input.waived) return 'waived';
  return 'none';
}

export function logAuthLoginOk(fields: {
  uid: string;
  via: string;
  method: string;
  second: AuthLoginSecond;
  ip: string;
  origin: string;
}): void {
  logLine(
    '[auth]',
    `login ok uid=${fields.uid} via=${fields.via} method=${fields.method} second=${fields.second} ip=${maskAuthClientIp(fields.ip)} origin=${fields.origin}`
  );
}

export function logAuthLoginSuccessIfOk(
  res: Response,
  fields: {
    uid: string;
    via: string;
    method: string;
    totpBody: unknown;
    passkeyBody: unknown;
    waived: boolean;
    ip: string;
    origin: string;
  }
): void {
  if (res.status !== 200) return;
  logAuthLoginOk({
    uid: fields.uid,
    via: fields.via,
    method: fields.method,
    second: resolveLoginSecond({
      method: fields.method,
      totpPresent: factorBodyPresent(fields.totpBody, 'code'),
      passkeyPresent: factorBodyPresent(fields.passkeyBody, 'sig'),
      waived: fields.waived,
    }),
    ip: fields.ip,
    origin: fields.origin,
  });
}

export function logAuthLoginFailed(fields: { uid: string; code: string; ip: string }): void {
  logLine(
    '[auth]',
    `login failed uid=${fields.uid} code=${fields.code} ip=${maskAuthClientIp(fields.ip)}`
  );
}

export function logAuthLoginLocked(fields: {
  uid: string;
  until: number;
  reason: string;
}): void {
  logLine(
    '[auth]',
    `login locked uid=${fields.uid} until=${new Date(fields.until).toISOString()} reason=${fields.reason}`
  );
}

export function logAuthLogout(fields: { uid: string; sessions: number }): void {
  logLine('[auth]', `logout uid=${fields.uid} sessions=${fields.sessions}`);
}

export function logAuthSessionRevoked(fields: { uid: string; reason: string }): void {
  logLine('[auth]', `session revoked uid=${fields.uid} reason=${fields.reason}`);
}

const REVOKE_EFFECTS = new Set<KeyLogEffect['type']>([
  'revokeAllSessions',
  'revokeSessionsByCredential',
  'revokeSessionsVia',
]);

export function logAuthSessionRevokes(uid: string, effects: readonly KeyLogEffect[]): void {
  for (const effect of effects) {
    if (REVOKE_EFFECTS.has(effect.type)) {
      logAuthSessionRevoked({ uid, reason: effect.type });
    }
  }
}

/** NodeSessionStore 未暴露活跃会话计数；审计只读其 drizzle 连接。 */
export function countActiveNodeSessions(store: NodeSessionStore, userId: string): number {
  const db = (store as unknown as { db: AuthDb }).db;
  const row = db
    .select({ n: count() })
    .from(nodeSessions)
    .where(and(eq(nodeSessions.userId, userId), isNull(nodeSessions.revokedAt)))
    .get();
  return Number(row?.n ?? 0);
}

function factorBodyPresent(value: unknown, key: 'code' | 'sig'): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec[key] === 'string' && rec[key].length > 0;
}

function stripIpLiteral(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end > 0) return trimmed.slice(1, end);
  }
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(trimmed);
  return v4port?.[1] ?? trimmed;
}

function maskIpv4(host: string): string {
  const parts = host.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

function maskIpv6Prefix48(host: string): string {
  const hextets = expandIpv6Hextets(host);
  return hextets ? formatIpv6Prefix48(hextets) : host;
}

function expandIpv6Hextets(host: string): string[] | null {
  const raw = host.toLowerCase().split('%')[0] ?? host.toLowerCase();
  const sides = raw.split('::');
  if (sides.length > 2) return null;
  if (sides.length === 1) {
    const parts = parseIpv6Side(sides[0]);
    return parts?.length === 8 ? parts : null;
  }
  const left = parseIpv6Side(sides[0]);
  const right = parseIpv6Side(sides[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill('0'), ...right];
}

function parseIpv6Side(side: string | undefined): string[] | null {
  if (side === undefined || side.length === 0) return [];
  const parts = side.split(':');
  if (parts.some((part) => part.length === 0 || part.length > 4 || !/^[0-9a-f]+$/.test(part))) {
    return null;
  }
  return parts;
}

function formatIpv6Prefix48(hextets: string[]): string {
  const p0 = stripHextet(hextets[0] ?? '0');
  const p1 = stripHextet(hextets[1] ?? '0');
  const p2 = stripHextet(hextets[2] ?? '0');
  if (p0 === '0' && p1 === '0' && p2 === '0') return '::';
  if (p1 === '0' && p2 === '0') return `${p0}::`;
  if (p2 === '0') return `${p0}:${p1}::`;
  return `${p0}:${p1}:${p2}::`;
}

function stripHextet(hextet: string): string {
  const stripped = hextet.replace(/^0+(?=\w)/, '');
  return stripped.length > 0 ? stripped : '0';
}
