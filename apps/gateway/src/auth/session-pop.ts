import {
  POP_QUERY_PARAM,
  type PopTarget,
  popTargetFromUrl,
  verifyPop,
} from '@vibeterm/shared/auth';
import { NAV_TICKET_HEADER, POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { parseCookies, readNavTicketCookie } from './cookies';
import { verifyNavTicket } from './nav-ticket';
import type { NodeSessionRecord } from './node-session-store';

/**
 * 会话持有证明（PoP）的服务端判定。只对 `pop_required` 会话生效：
 * - 非安全方法：`x-vibeterm-pop` 必须有效，nonce 在 120 s 内按 sid 只认一次；
 * - GET / HEAD：有效的 PoP 头或有效的导航票据二选一（nonce 不记，入口的幂等重试能通过）；
 * - WebSocket 升级：`?pop=` 或 PoP 头，目标为升级路径 + 去掉 `pop` 的查询串，只在升级时证明一次。
 */
export const POP_REQUIRED = 'POP_REQUIRED';
export const POP_INVALID = 'POP_INVALID';
export type PopFailureCode = typeof POP_REQUIRED | typeof POP_INVALID;

export const POP_NONCE_TTL_MS = 120_000;
export const POP_NONCE_MAX_ENTRIES = 50_000;
export const WS_POP_RESUME_GRACE_MS = 10 * 60 * 1000;
export const WS_POP_RESUME_MAX_ENTRIES = 10_000;

/**
 * 进程内标记（不上线路）：入口已对本次请求的会话验过 PoP。`forwardAuthorizedHttp` 带上它，
 * `openHttpStream` 把它换成流 OPEN 的 `popEntry` 字段后删掉；浏览器自带的同名头由入口丢弃。
 */
export const POP_ENTRY_PROVEN_HEADER = 'x-vibeterm-pop-entry-proven';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type PopSession = Pick<NodeSessionRecord, 'sid' | 'popRequired' | 'sessPublicKey'>;

export type PopEvidence = {
  target: PopTarget;
  proof: string | null;
  nav: string | null;
  upgrade: boolean;
  /**
   * mesh 入站：入口已凭 PoP 头验过本次服务端代发调用背后的浏览器请求，这是入口那条会话的公钥。
   * 只有目标会话同属一次登录（`sess_public_key` 相同）时才算数。
   */
  entryProvenPk?: Uint8Array | null;
};

export type PopCheckDeps = {
  now: number;
  navKey: () => Uint8Array;
  nonces?: PopNonceCache;
  /** ws 流续接：同一证明在原连接存活期内（及其后的宽限期）可再次打开流。 */
  acceptResumed?: (sid: string, proof: string, query: string) => boolean;
};

export class PopNonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = POP_NONCE_TTL_MS,
    private readonly maxEntries = POP_NONCE_MAX_ENTRIES
  ) {}

  /** 首次出现返回 true 并记下；TTL 内重复出现返回 false。 */
  claim(sid: string, nonce: string, now: number): boolean {
    this.prune(now);
    const key = `${sid}.${nonce}`;
    const until = this.seen.get(key);
    if (until !== undefined && until > now) return false;
    this.seen.delete(key);
    this.seen.set(key, now + this.ttlMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [key, until] of this.seen) {
      if (until > now) return;
      this.seen.delete(key);
    }
  }
}

/** 进程级 nonce 表：本机 HTTP 与 mesh 入站共用，同一 sid 的证明无论从哪条路进来都只认一次。 */
export const sessionPopNonces = new PopNonceCache();

type ResumeEntry = { live: number; idleUntil: number };

/**
 * mesh ws 流的续接窗口。入口切链路时用升级时那份证明重开流，证明早已超出 60 s 时间窗；
 * 只要原来那条流还挂着（或刚断不到宽限期），目标节点就认这份已验过的证明。键含升级查询串
 * （带 cid），只能续同一条连接；同时最多再挂一条替身流，不能借它开任意多条并发连接。
 */
export class WsPopResume {
  private readonly entries = new Map<string, ResumeEntry>();

  constructor(
    private readonly graceMs = WS_POP_RESUME_GRACE_MS,
    private readonly maxEntries = WS_POP_RESUME_MAX_ENTRIES,
    private readonly clock: () => number = () => Date.now()
  ) {}

  accepts(sid: string, proof: string, query: string, now: number): boolean {
    const entry = this.entries.get(resumeKey(sid, proof, query));
    if (!entry) return false;
    return entry.live === 1 || (entry.live === 0 && entry.idleUntil > now);
  }

  /** 记一条挂上的流，返回释放函数（幂等）。 */
  attach(sid: string, proof: string, query: string): () => void {
    const key = resumeKey(sid, proof, query);
    const entry = this.entries.get(key) ?? { live: 0, idleUntil: 0 };
    entry.live += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.live = Math.max(0, entry.live - 1);
      if (entry.live === 0) entry.idleUntil = this.clock() + this.graceMs;
    };
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.live === 0 && entry.idleUntil <= now) this.entries.delete(key);
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.live === 0) this.entries.delete(key);
    }
  }
}

function resumeKey(sid: string, proof: string, query: string): string {
  return `${sid}\n${proof}\n${query}`;
}

export const wsPopResume = new WsPopResume();

function proofValid(session: PopSession, proof: string | null, target: PopTarget, now: number) {
  return proof ? verifyPop(session.sessPublicKey, proof, target, now).ok : false;
}

function checkUpgrade(
  session: PopSession,
  evidence: PopEvidence,
  deps: PopCheckDeps
): PopFailureCode | null {
  const { proof } = evidence;
  if (!proof) return POP_REQUIRED;
  if (proofValid(session, proof, { ...evidence.target, method: 'GET' }, deps.now)) return null;
  return deps.acceptResumed?.(session.sid, proof, evidence.target.query) ? null : POP_INVALID;
}

function checkSafe(
  session: PopSession,
  evidence: PopEvidence,
  deps: PopCheckDeps
): PopFailureCode | null {
  if (!evidence.proof && !evidence.nav) return POP_REQUIRED;
  if (proofValid(session, evidence.proof, evidence.target, deps.now)) return null;
  if (evidence.nav && verifyNavTicket(deps.navKey(), session.sid, evidence.nav, deps.now)) {
    return null;
  }
  return POP_INVALID;
}

function checkUnsafe(
  session: PopSession,
  evidence: PopEvidence,
  deps: PopCheckDeps
): PopFailureCode | null {
  const { proof } = evidence;
  if (!proof) return POP_REQUIRED;
  const verified = verifyPop(session.sessPublicKey, proof, evidence.target, deps.now);
  if (!verified.ok) return POP_INVALID;
  const nonces = deps.nonces ?? sessionPopNonces;
  return nonces.claim(session.sid, verified.proof.nonce, deps.now) ? null : POP_INVALID;
}

/** 唯一判定点：本机 HTTP / WS、令牌守卫的会话分支、exec 升级与 mesh 入站流都走这里。 */
export function evaluatePop(
  session: PopSession,
  evidence: PopEvidence | null | undefined,
  deps: PopCheckDeps
): PopFailureCode | null {
  if (!session.popRequired) return null;
  if (!evidence) return POP_REQUIRED;
  if (entryVouches(session, evidence.entryProvenPk)) return null;
  if (evidence.upgrade) return checkUpgrade(session, evidence, deps);
  const method = evidence.target.method.toUpperCase();
  if (method === 'OPTIONS') return null;
  if (SAFE_METHODS.has(method)) return checkSafe(session, evidence, deps);
  return checkUnsafe(session, evidence, deps);
}

function entryVouches(session: PopSession, pk: Uint8Array | null | undefined): boolean {
  if (!pk || pk.byteLength !== session.sessPublicKey.byteLength) return false;
  return pk.every((byte, i) => byte === session.sessPublicKey[i]);
}

export function isPopFailureCode(value: unknown): value is PopFailureCode {
  return value === POP_REQUIRED || value === POP_INVALID;
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** 本机请求的证据：目标路径去掉 `/n/self|<id>` 前缀；导航票据读 `vibeterm_n_self` cookie。 */
export function requestPopEvidence(req: Request): PopEvidence {
  const url = new URL(req.url);
  const upgrade = isWebSocketUpgrade(req);
  const header = req.headers.get(POP_HEADER);
  const query = upgrade ? url.searchParams.get(POP_QUERY_PARAM) : null;
  const nav =
    readNavTicketCookie(parseCookies(req.headers.get('cookie')), 'self') ??
    req.headers.get(NAV_TICKET_HEADER);
  return {
    target: popTargetFromUrl(upgrade ? 'GET' : req.method, url),
    proof: header || query || null,
    nav: nav || null,
    upgrade,
  };
}

const requestOutcomes = new WeakMap<Request, Map<string, PopFailureCode | null>>();
const provenKeys = new WeakMap<Request, Uint8Array>();

/**
 * 同一个 Request 会被多处鉴权（localUiGuard、路由的 requireSession…），结果按 sid 记在请求上，
 * 否则第二次判定会把第一次刚记下的 nonce 当成重放。
 */
export function enforceRequestPop(
  req: Request,
  session: PopSession,
  deps: Omit<PopCheckDeps, 'acceptResumed'>
): PopFailureCode | null {
  if (!session.popRequired) return null;
  const memo = requestOutcomes.get(req) ?? new Map<string, PopFailureCode | null>();
  if (memo.has(session.sid)) return memo.get(session.sid) ?? null;
  const outcome = evaluatePop(session, requestPopEvidence(req), deps);
  memo.set(session.sid, outcome);
  requestOutcomes.set(req, memo);
  if (outcome === null && provedByHeader(session, req, deps.now)) {
    provenKeys.set(req, session.sessPublicKey);
  }
  return outcome;
}

/** 只认签名头（或升级证明）：导航票据只是 GET 的替代凭证，不能拿来替代发调用担保。 */
function provedByHeader(session: PopSession, req: Request, now: number): boolean {
  const evidence = requestPopEvidence(req);
  const method = evidence.upgrade ? 'GET' : evidence.target.method;
  return proofValid(session, evidence.proof, { ...evidence.target, method }, now);
}

/** 本次请求凭 PoP 头证明过持有私钥的 `pop_required` 会话公钥；没有则为 null。 */
export function requestPopProvenKey(req: Request): Uint8Array | null {
  return provenKeys.get(req) ?? null;
}

const popForwardingRequests = new WeakSet<Request>();

/**
 * 入口能力标记：新版入口在每条转发流的 OPEN 上带 `popForwarding: true`（导航票据、ws 证明、代发担保
 * 都能转）。经旧入口登录时没有这个标记，目标节点就签普通会话，避免客户端被锁在旧入口后面。
 */
export function markPopForwardingRequest(req: Request, flag: unknown): void {
  if (flag === true) popForwardingRequests.add(req);
}

/** 登录声明了 `pop: true` 时是否真的签 `pop_required`：本机登录，或经能转发 PoP 的新版入口。 */
export function popLoginAllowed(req: Request, via: string, requested: unknown): boolean {
  return requested === true && (via === 'self' || popForwardingRequests.has(req));
}

export function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/** mesh ws / exec 流的证据：入口随 OPEN 带来的证明与去掉 `pop` 的原始查询串。 */
export function streamUpgradeEvidence(path: string, open: { pop?: unknown; popQuery?: unknown }) {
  const proof = typeof open.pop === 'string' && open.pop ? open.pop : null;
  return {
    target: { method: 'GET', path, query: typeof open.popQuery === 'string' ? open.popQuery : '' },
    proof,
    nav: null,
    upgrade: true,
  } satisfies PopEvidence;
}
