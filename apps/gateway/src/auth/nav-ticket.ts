import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SET_NAV_TICKET_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { eq } from 'drizzle-orm';
import { gatewayKv } from '../db/schema';
import { fromBase64Url, toBase64Url } from './binary';
import type { AuthDb } from './types';

/**
 * 导航票据：`<img>` / `<video>` / 下载链接 / `window.open` 这类带不了请求头的 GET 用它代替
 * 逐请求的 PoP 头。票据 = b64url(exp_ms 8 字节大端 || HMAC-SHA256(navKey, sid || exp_ms))，
 * 绑定 sid，10 分钟有效；只能由已证明持有会话私钥的请求（`POST /api/auth/nav`）换取。
 */
export const NAV_TICKET_TTL_MS = 10 * 60 * 1000;
export const NAV_TICKET_MAX_AGE_SEC = NAV_TICKET_TTL_MS / 1000;
export const NAV_KEY_KV = 'session_nav_key';

const NAV_KEY_BYTES = 32;
const EXP_BYTES = 8;
const MAC_BYTES = 32;

export function loadOrCreateNavKey(db: AuthDb): Uint8Array {
  const existing = readNavKey(db);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.insert(gatewayKv)
    .values({ key: NAV_KEY_KV, value: toBase64Url(randomBytes(NAV_KEY_BYTES)), updatedAt: now })
    .onConflictDoNothing()
    .run();
  const stored = readNavKey(db);
  if (!stored) throw new Error('nav ticket key unavailable');
  return stored;
}

function readNavKey(db: AuthDb): Uint8Array | null {
  const row = db.select().from(gatewayKv).where(eq(gatewayKv.key, NAV_KEY_KV)).get();
  if (!row) return null;
  const bytes = fromBase64Url(row.value);
  return bytes.byteLength === NAV_KEY_BYTES ? new Uint8Array(bytes) : null;
}

function expBytes(expiresAt: number): Buffer {
  const out = Buffer.alloc(EXP_BYTES);
  out.writeBigUInt64BE(BigInt(expiresAt));
  return out;
}

function ticketMac(key: Uint8Array, sid: string, exp: Buffer): Buffer {
  return createHmac('sha256', key).update(Buffer.from(sid, 'utf8')).update(exp).digest();
}

export function issueNavTicket(
  key: Uint8Array,
  sid: string,
  now: number
): { ticket: string; expiresAt: number } {
  const expiresAt = Math.floor(now) + NAV_TICKET_TTL_MS;
  const exp = expBytes(expiresAt);
  const ticket = toBase64Url(Buffer.concat([exp, ticketMac(key, sid, exp)]));
  return { ticket, expiresAt };
}

export function verifyNavTicket(
  key: Uint8Array,
  sid: string,
  ticket: string | null | undefined,
  now: number
): boolean {
  if (!ticket || ticket.length > 128 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return false;
  const raw = fromBase64Url(ticket);
  if (raw.byteLength !== EXP_BYTES + MAC_BYTES) return false;
  const exp = raw.subarray(0, EXP_BYTES);
  const expiresAt = Number(exp.readBigUInt64BE());
  if (expiresAt <= now || expiresAt > now + NAV_TICKET_TTL_MS) return false;
  return timingSafeEqual(raw.subarray(EXP_BYTES), ticketMac(key, sid, exp));
}

/** 内部头 `x-vibeterm-set-nav` 的值：`<ticket>;<maxAgeSec>`；ticket 为空即清除。 */
export function parseSetNavHeader(
  value: string | null
): { ticket: string; maxAgeSec: number } | null {
  if (!value) return null;
  const split = value.indexOf(';');
  if (split === -1) return null;
  const ticket = value.slice(0, split).trim();
  const maxAgeSec = Number(value.slice(split + 1).trim());
  if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) return null;
  if (ticket && !/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) return null;
  return { ticket, maxAgeSec: Math.floor(maxAgeSec) };
}

/**
 * `POST /api/auth/nav` 的响应：票据绑定本次请求的 sid，走内部头 `x-vibeterm-set-nav`；
 * 本机由响应出口换成 `vibeterm_n_self`，经入口则由入口换成 `vibeterm_n_<本节点>`。
 */
export function navTicketResponse(
  deps: { nodeSessionStore: { navKey(): Uint8Array }; now?: () => number },
  sid: string | null
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (!sid) return new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401, headers });
  const now = deps.now?.() ?? Date.now();
  const issued = issueNavTicket(deps.nodeSessionStore.navKey(), sid, now);
  headers.set(SET_NAV_TICKET_HEADER, `${issued.ticket};${NAV_TICKET_MAX_AGE_SEC}`);
  return new Response(JSON.stringify({ expires_at: issued.expiresAt }), { status: 200, headers });
}

/** 登出：连同会话 cookie 一起清掉导航票据 cookie。 */
export function clearNavTicket(headers: Headers): void {
  headers.set(SET_NAV_TICKET_HEADER, ';0');
}
