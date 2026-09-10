import { encodeBase64url } from '@vibeterm/shared/auth';
import type { GatewaySession } from '../ws/gateway-session';
import type { ConnectionLookupResult } from './mesh-deps';

export const CONNECTION_ID_BYTES = 32;

export function generateConnectionId(): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(CONNECTION_ID_BYTES)));
}

export type RegisteredGatewaySession = {
  connectionId: string;
  cid?: string;
  sid: string;
  uid: string;
  via: string;
  session: GatewaySession;
  lastVerifyAt: number;
  /** 下一次允许压库复验的时刻，由 `sessionVerifyDeadline` 按会话过期时间算出。 */
  nextVerifyAt: number;
  pc?: { close(): void };
};

export type RegisterGatewaySessionInput = {
  sid: string;
  uid: string;
  via: string;
  session: GatewaySession;
  connectionId?: string;
  cid?: string;
  pc?: { close(): void };
};

export type RegisterGatewaySessionResult =
  | { ok: true; entry: RegisteredGatewaySession }
  | { ok: false; code: 'DUPLICATE_CONNECTION' | 'DUPLICATE_CID' };

function cidIndexKey(sid: string, via: string, cid: string): string {
  return `${sid}\0${via}\0${cid}`;
}

export const CID_MAX_LENGTH = 64;

/**
 * cid 由浏览器自由指定，既进日志又当注册表键：只留安全字符并限长。
 * 客户端生成的 nonce 是 base64url，本来就落在这个字符集里，正常连接不受影响。
 */
export function sanitizeCid(value: string | undefined | null): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[^\w.:-]/g, '')
    .slice(0, CID_MAX_LENGTH);
}

function normalizeCid(value: string | undefined | null): string {
  return sanitizeCid(value);
}

export class SessionRegistry {
  private readonly byConnection = new Map<string, RegisteredGatewaySession>();
  private readonly bySession = new WeakMap<GatewaySession, string>();
  private readonly connectionsBySid = new Map<string, Set<string>>();
  private readonly byCid = new Map<string, string>();

  register(entry: RegisterGatewaySessionInput): RegisterGatewaySessionResult {
    const cid = normalizeCid(entry.cid);
    const providedId = typeof entry.connectionId === 'string' ? entry.connectionId.trim() : '';
    const taken = (id: string | undefined) => {
      const e = id ? this.byConnection.get(id) : undefined;
      return Boolean(e && e.session !== entry.session && !e.session.closed);
    };
    if (providedId && taken(providedId)) return { ok: false, code: 'DUPLICATE_CONNECTION' };
    if (cid && taken(this.byCid.get(cidIndexKey(entry.sid, entry.via, cid)))) {
      return { ok: false, code: 'DUPLICATE_CID' };
    }
    let connectionId = providedId;
    if (!connectionId) {
      do {
        connectionId = generateConnectionId();
      } while (this.byConnection.has(connectionId));
    }
    const prevSame = this.byConnection.get(connectionId);
    if (prevSame?.session === entry.session) this.drop(prevSame);
    const stored: RegisteredGatewaySession = {
      connectionId,
      sid: entry.sid,
      uid: entry.uid,
      via: entry.via,
      session: entry.session,
      lastVerifyAt: 0,
      nextVerifyAt: 0,
      ...(cid ? { cid } : {}),
      ...(entry.pc ? { pc: entry.pc } : {}),
    };
    this.byConnection.set(connectionId, stored);
    this.bySession.set(entry.session, connectionId);
    let set = this.connectionsBySid.get(entry.sid);
    if (!set) {
      set = new Set();
      this.connectionsBySid.set(entry.sid, set);
    }
    set.add(connectionId);
    if (cid) this.byCid.set(cidIndexKey(entry.sid, entry.via, cid), connectionId);
    return { ok: true, entry: stored };
  }

  unregister(sid: string, session?: GatewaySession): void {
    if (session) {
      this.unregisterSession(session);
      return;
    }
    for (const entry of this.listBySid(sid)) this.drop(entry);
  }

  unregisterSession(session: GatewaySession): void {
    const connectionId = this.bySession.get(session);
    if (!connectionId) return;
    const entry = this.byConnection.get(connectionId);
    if (entry) this.drop(entry);
  }

  get(sid: string): RegisteredGatewaySession | null {
    const live = this.listBySid(sid);
    return live.length === 1 ? (live[0] ?? null) : null;
  }

  getByConnectionId(connectionId: string): RegisteredGatewaySession | null {
    const entry = this.byConnection.get(connectionId);
    if (!entry || entry.session.closed) return null;
    return entry;
  }

  getBySession(session: GatewaySession): RegisteredGatewaySession | null {
    const connectionId = this.bySession.get(session);
    return connectionId ? this.getByConnectionId(connectionId) : null;
  }

  listBySid(sid: string): RegisteredGatewaySession[] {
    const ids = this.connectionsBySid.get(sid);
    if (!ids) return [];
    const out: RegisteredGatewaySession[] = [];
    for (const id of ids) {
      const entry = this.byConnection.get(id);
      if (entry && !entry.session.closed) out.push(entry);
    }
    return out;
  }

  listByUid(uid: string): RegisteredGatewaySession[] {
    const out: RegisteredGatewaySession[] = [];
    for (const entry of this.byConnection.values()) {
      if (entry.uid === uid && !entry.session.closed) out.push(entry);
    }
    return out;
  }

  /**
   * 撤销通知（登出 / key log 会话效果）影响到的登记项逐个复核。一次 `remove-passkey`
   * 只吊销该凭证签发的会话，不能连坐无关会话，所以这里是复验而不是一律拆。
   */
  reverifyRevoked(
    target: { uid?: string; sid?: string },
    verify: (entry: RegisteredGatewaySession, force: boolean) => unknown
  ): void {
    const rows = target.sid ? this.listBySid(target.sid) : this.listByUid(target.uid ?? '');
    for (const entry of rows) verify(entry, true);
  }

  lookup(
    sid: string,
    via: string,
    connectionId?: string | null,
    cid?: string | null
  ): ConnectionLookupResult {
    const nonce = normalizeCid(cid);
    if (nonce || connectionId) {
      const id = nonce ? this.byCid.get(cidIndexKey(sid, via, nonce)) : connectionId;
      const entry = id ? this.getByConnectionId(id) : null;
      return entry && entry.sid === sid && entry.via === via
        ? { ok: true, connectionId: entry.connectionId }
        : { ok: false, code: 'NO_CONNECTION' };
    }
    const matches = this.listBySid(sid).filter((entry) => entry.via === via);
    if (matches.length === 0) return { ok: false, code: 'NO_CONNECTION' };
    if (matches.length > 1) return { ok: false, code: 'MULTIPLE_CONNECTIONS' };
    const only = matches[0];
    if (!only) return { ok: false, code: 'NO_CONNECTION' };
    return { ok: true, connectionId: only.connectionId };
  }

  private drop(entry: RegisteredGatewaySession): void {
    this.byConnection.delete(entry.connectionId);
    this.bySession.delete(entry.session);
    if (entry.cid) this.byCid.delete(cidIndexKey(entry.sid, entry.via, entry.cid));
    const set = this.connectionsBySid.get(entry.sid);
    if (!set) return;
    set.delete(entry.connectionId);
    if (set.size === 0) this.connectionsBySid.delete(entry.sid);
  }
}
