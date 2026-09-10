// HTTP 核心：按 node 记账的 cookie 罐 + `Origin` 固定为 entry + 会话续期头处理。
//
// 与浏览器完全同构：访问别的 node 一律走 entry 的 `/n/<id>/…` 转发，并带上该 node 自己的
// 会话 cookie；CLI 不使用任何本机 mesh 身份或主密钥。

import { SELF_NODE_ID, resolveNodeUrl } from '@vibeterm/api-client/node-url';
import {
  SESSION_RENEWED_HEADER,
  SET_SESSION_HEADER,
  readHeaderPair,
} from '@vibeterm/shared/http/mesh-headers';
import {
  AuthError,
  CliError,
  EXIT_GENERIC,
  NetworkError,
  NotFoundError,
  PermissionError,
} from './errors';
import type { NodeSession, SessionStore } from './session-store';
import { DEFAULT_TLS, type TlsSettings, fetchTlsInit } from './tls';

/** 与 apps/gateway/src/auth/cookies.ts 保持一致；混合版本期两个名字都发。 */
export const NODE_SESSION_COOKIE_PREFIX = 'vibeterm_s_';
export const LEGACY_NODE_SESSION_COOKIE_PREFIX = 'tmex_s_';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function nodeSessionCookieName(nodeId: string): string {
  return `${NODE_SESSION_COOKIE_PREFIX}${nodeId}`;
}

/** 会话失效的服务端判词；命中即提示重新登录该 node。 */
const REJECTED_SESSION_REASONS: ReadonlySet<string> = new Set([
  'via_mismatch',
  'expired',
  'revoked',
  'unknown',
  'NODE_LOGIN_REQUIRED',
  'UNAUTHORIZED',
]);

export interface CookieJar {
  get(nodeId: string): NodeSession | null;
  set(nodeId: string, sid: string, expiresAt: number): void;
  clear(nodeId: string): void;
  list(): NodeSession[];
}

/** 落盘的 cookie 罐：每次写入立即持久化，命令中途被打断也不会丢掉刚拿到的会话。 */
export function createSessionCookieJar(store: SessionStore, entry: string): CookieJar {
  return {
    get(nodeId) {
      return store.entry(entry)?.nodes[nodeId] ?? null;
    },
    set(nodeId, sid, expiresAt) {
      store.setNodeSession(entry, { nodeId, sid, expiresAt });
      store.save();
    },
    clear(nodeId) {
      store.clearNodeSession(entry, nodeId);
      store.save();
    },
    list() {
      return Object.values(store.entry(entry)?.nodes ?? {});
    },
  };
}

export function createMemoryCookieJar(): CookieJar {
  const nodes = new Map<string, NodeSession>();
  return {
    get: (nodeId) => nodes.get(nodeId) ?? null,
    set: (nodeId, sid, expiresAt) => {
      nodes.set(nodeId, { nodeId, sid, expiresAt });
    },
    clear: (nodeId) => {
      nodes.delete(nodeId);
    },
    list: () => [...nodes.values()],
  };
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

export interface ParsedSetCookie {
  nodeId: string;
  sid: string;
  maxAgeSec: number | null;
}

/** 只认会话 cookie（新旧两个前缀），其余（分享凭据等）交给各自的命令处理。 */
export function parseSessionSetCookie(header: string): ParsedSetCookie | null {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const prefix = [NODE_SESSION_COOKIE_PREFIX, LEGACY_NODE_SESSION_COOKIE_PREFIX].find((item) =>
    name.startsWith(item)
  );
  if (!prefix) return null;
  const nodeId = name.slice(prefix.length);
  if (!nodeId) return null;
  let maxAgeSec: number | null = null;
  for (const attr of attrs) {
    const [key, raw] = attr.split('=');
    if (key.trim().toLowerCase() !== 'max-age') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) maxAgeSec = parsed;
  }
  return { nodeId, sid: value, maxAgeSec };
}

/** `x-vibeterm-set-session: <sid>;<maxAgeSec>`；`;0` 是登出（sid 为空）。 */
export function parseSetSessionHeader(raw: string): { sid: string; maxAgeSec: number } | null {
  const separator = raw.indexOf(';');
  if (separator < 0) return null;
  const sid = raw.slice(0, separator);
  const maxAgeSec = Number(raw.slice(separator + 1));
  if (!Number.isFinite(maxAgeSec)) return null;
  return { sid, maxAgeSec };
}

export interface HttpClientOptions {
  entry: string;
  timeoutMs: number;
  jar: CookieJar;
  fetchImpl?: FetchLike;
  /** `--ca` / `--insecure`；缺省为「按系统信任库校验」。 */
  tls?: TlsSettings;
}

export interface RequestOptions extends Omit<RequestInit, 'signal'> {
  /** 覆盖全局 `--timeout`；null 表示不设超时（长连 NDJSON 流用）。 */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  const usable = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  const anySignal = (AbortSignal as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  return anySignal ? anySignal(usable) : usable[0];
}

export class HttpClient {
  readonly entry: string;
  readonly origin: string;
  readonly tls: TlsSettings;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: HttpClientOptions) {
    this.entry = options.entry;
    this.origin = new URL(options.entry).origin;
    this.tls = options.tls ?? DEFAULT_TLS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get jar(): CookieJar {
    return this.options.jar;
  }

  url(nodeId: string, path: string): string {
    return `${this.entry}${resolveNodeUrl(nodeId, path)}`;
  }

  /** entry 自身的会话 + 目标 node 的会话；转发链路两者都要看。 */
  cookieHeader(nodeId: string): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const id of [SELF_NODE_ID, nodeId]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const session = this.options.jar.get(id);
      if (!session) continue;
      parts.push(`${NODE_SESSION_COOKIE_PREFIX}${id}=${session.sid}`);
      parts.push(`${LEGACY_NODE_SESSION_COOKIE_PREFIX}${id}=${session.sid}`);
    }
    return parts.join('; ');
  }

  /** 发一次请求；非 2xx 不抛（交给 `assertOk` 或调用方），网络层失败抛 NetworkError。 */
  async fetch(nodeId: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const { timeoutMs, signal, headers, ...rest } = options;
    const requestHeaders = new Headers(headers);
    requestHeaders.set('origin', this.origin);
    requestHeaders.set('accept', requestHeaders.get('accept') ?? 'application/json, */*');
    const cookie = this.cookieHeader(nodeId);
    if (cookie) requestHeaders.set('cookie', cookie);

    const effectiveTimeout = timeoutMs === undefined ? this.options.timeoutMs : timeoutMs;
    const combined = combineSignals([
      ...(signal ? [signal] : []),
      ...(effectiveTimeout === null ? [] : [AbortSignal.timeout(effectiveTimeout)]),
    ]);

    const url = this.url(nodeId, path);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...rest,
        headers: requestHeaders,
        ...(combined ? { signal: combined } : {}),
        // Bun 认 per-request TLS 选项；Node 上是多余字段（由进程信任库那条路径生效）。
        ...fetchTlsInit(this.tls),
        redirect: 'manual',
      });
    } catch (error) {
      throw new NetworkError(`${describeRequest(rest.method, url)}: ${describeFetchError(error)}`);
    }
    this.captureSession(nodeId, response);
    return response;
  }

  /**
   * 从响应里回收会话：Set-Cookie（经 entry 的常规路径）与内部 set-session 头都认。
   *
   * 只收 `self` 与**本次请求目标**这两把：一次重定向或一个被塞了别的 node cookie 的响应，
   * 不该让我们把另一台 node 的会话换成对面给的值（真实浏览器由 cookie 作用域挡住，
   * 我们只有一个进程内的罐子，得自己挡）。
   */
  private captureSession(nodeId: string, response: Response): void {
    const acceptable: ReadonlySet<string> = new Set([SELF_NODE_ID, nodeId]);
    for (const header of setCookieHeaders(response)) {
      const parsed = parseSessionSetCookie(header);
      if (!parsed || !acceptable.has(parsed.nodeId)) continue;
      if (!parsed.sid || parsed.maxAgeSec === 0) {
        this.options.jar.clear(parsed.nodeId);
        continue;
      }
      this.options.jar.set(
        parsed.nodeId,
        parsed.sid,
        parsed.maxAgeSec === null ? 0 : Date.now() + parsed.maxAgeSec * 1000
      );
    }
    const raw = readHeaderPair(response.headers, SET_SESSION_HEADER);
    const parsed = raw ? parseSetSessionHeader(raw) : null;
    if (parsed) {
      if (parsed.sid) {
        this.options.jar.set(nodeId, parsed.sid, Date.now() + parsed.maxAgeSec * 1000);
      } else {
        this.options.jar.clear(nodeId);
      }
    }
    const renewed = readHeaderPair(response.headers, SESSION_RENEWED_HEADER);
    const expiresAt = renewed ? Number(renewed) : Number.NaN;
    const current = this.options.jar.get(nodeId);
    if (current && Number.isFinite(expiresAt)) {
      this.options.jar.set(nodeId, current.sid, expiresAt);
    }
  }

  /** 非 2xx 一律抛；状态码 → 退出码的映射见 `httpStatusError`。 */
  async assertOk(nodeId: string, response: Response, path: string): Promise<Response> {
    if (response.ok) return response;
    throw httpStatusError(nodeId, path, response.status, await peekBody(response));
  }

  async json<T>(
    nodeId: string,
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetch(nodeId, path, {
      ...options,
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await this.assertOk(nodeId, response, path);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async bytes(nodeId: string, path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.fetch(nodeId, path, options);
    await this.assertOk(nodeId, response, path);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** NDJSON 流：逐行 yield 已解析的对象；默认不设超时。 */
  async *ndjson(
    nodeId: string,
    path: string,
    options: RequestOptions = {}
  ): AsyncGenerator<unknown> {
    const response = await this.fetch(nodeId, path, { timeoutMs: null, ...options });
    await this.assertOk(nodeId, response, path);
    const body = response.body;
    if (!body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
  }
}

function describeRequest(method: string | undefined, url: string): string {
  return `${(method ?? 'GET').toUpperCase()} ${url}`;
}

function describeFetchError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'request timed out';
  return error instanceof Error ? error.message : String(error);
}

async function peekBody(response: Response): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, 2048).trim();
  } catch {
    return '';
  }
}

function reasonFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    if (typeof parsed.code === 'string') return parsed.code;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON 体：没有业务码
  }
  return null;
}

/**
 * 403 里仍属于「会话 / 需要登录」的判词。其余 403（`outside_roots`、`FORBIDDEN`、
 * `UPGRADE_NOT_ALLOWED`、`peer_mismatch` 等）是权限不足，重新登录也没用。
 */
function isAuthErrorCode(code: string | null): boolean {
  if (!code) return false;
  return (
    REJECTED_SESSION_REASONS.has(code) ||
    code.startsWith('SESSION_') ||
    code.endsWith('LOGIN_REQUIRED')
  );
}

function forbiddenError(path: string, code: string | null, body: string): PermissionError {
  const detail = body && body !== code ? `: ${body}` : '';
  return new PermissionError(`${path} → ${code ?? 'forbidden'}${detail}`.trim(), code ?? undefined);
}

/**
 * 非 2xx 响应 → CliError：401 与会话类 403 提示重新登录（退出码 3），其余 403 是权限
 * 不足（退出码 1，message 带服务端的业务码），404 → 4，其它 → 1。
 */
export function httpStatusError(
  nodeId: string,
  path: string,
  status: number,
  body: string
): CliError {
  const code = reasonFromBody(body);
  if (status === 401 || (status === 403 && isAuthErrorCode(code))) {
    return loginRequiredError(nodeId, body);
  }
  if (status === 403) return forbiddenError(path, code, body);
  if (status === 404) return new NotFoundError(`${path} → 404 ${body || 'not found'}`);
  return new CliError(`${path} → HTTP ${status} ${body}`.trim(), EXIT_GENERIC);
}

export function loginRequiredError(nodeId: string, body: string): AuthError {
  const reason = reasonFromBody(body);
  const target = nodeId === SELF_NODE_ID ? '' : ` --node ${nodeId}`;
  const known = reason && REJECTED_SESSION_REASONS.has(reason);
  const detail = reason ? ` (${reason})` : '';
  return new AuthError(
    `not authenticated for node ${nodeId}${detail}`,
    `run: vibeterm login${target}`,
    known ? reason : undefined
  );
}
