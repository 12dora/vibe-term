import { ForwardWsPumps } from './forwarder-ws-pump';
import { type PendingForwardOpen, upgradeRemoteWs } from './forwarder-ws-upgrade';
export {
  DEFAULT_PENDING_FORWARD_STREAM_TTL_MS,
  FORWARD_WS_LINK_FAILURE_CODE,
  FORWARD_WS_LINK_FAILURE_REASON,
  FORWARD_WS_LINK_TIMEOUT_REASON,
  expirePendingForwardStream,
  pendingForwardStreamCount,
  setPendingForwardStreamTtlMs,
  takePendingForwardStream,
} from './forwarder-ws-upgrade';
import { adaptiveDeadlineMs, nestedDialBudgetsMs } from '@vibeterm/shared/net';
import { readJsonObjectBody } from '../api/http';
import { parseCookies, readNodeSessionCookie } from '../auth/cookies';
import { isShareAccessPath } from './auth-public-paths';
import { type AuthRateLimits, authUidTooLong, peekLoginUid } from './auth-routes';
import { clientIpFromRequest } from './client-ip';
import {
  ForwardDeadlineError,
  authorizedAttemptBudgetsMs,
  runLinkThenTransfer,
  withHttpStreamUploadDeadline,
} from './forwarder-attempt-deadline';
import {
  AUTH_CHALLENGE_PATHS,
  AUTH_LOGIN_PATH,
  AUTH_SKIP,
  applyAuthPolicy,
  peekJsonCode,
} from './forwarder-auth-policy';
import { cancelForwardBody, countStreamBytes, throttledProgress } from './forwarder-body';
import { copyUpstreamHeaders, filterRequestHeaders } from './forwarder-headers';
import { parseNodePrefix } from './forwarder-path';
import { nodeUnreachableResponse } from './forwarder-unreachable';
import { buildJsonStreamBody } from './json-stream-body';
import {
  HTTP_FAILOVER_MAX_ATTEMPTS,
  MESH_VIA_SELF,
  type MeshHandleResult,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  STREAM_FAILOVER_BACKOFF_MS,
  type StreamOpener,
  getMeshRequestContext,
  setMeshRequestContext,
} from './mesh-deps';
import { stamp } from './mesh-log';
import { lookupPeerRttMs } from './peer-manager-state';
import { jsonError } from './session-middleware';
import { readShareCookie, shareAuthValue } from './share-credential';
import { ShareLoginQuota, shareLoginShareId } from './share-login-quota';

type ForwarderDeps = {
  nodeId: string;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  authRateLimits?: AuthRateLimits | null;
};

const IDEMPOTENT_HTTP = new Set(['GET', 'HEAD']);
/** 取链路的墙钟上限（LAN 缺省）；高 RTT 时按 nestedDialBudgetsMs 放大。 */
export const FORWARD_LINK_DEADLINE_MS = 5_000;
let forwardLinkDeadlineOverride = 0;

/** 测试用：缩短取链路的墙钟上限。`ms <= 0` 恢复自适应缺省。 */
export function setForwardLinkDeadlineMs(ms: number): void {
  forwardLinkDeadlineOverride = ms > 0 ? ms : 0;
}

function forwardLinkDeadlineFor(nodeId: string, rttMs?: number | null): number {
  if (forwardLinkDeadlineOverride > 0) return forwardLinkDeadlineOverride;
  return nestedDialBudgetsMs(rttMs ?? lookupPeerRttMs(nodeId)).forwardMs;
}

function authorizedHttpDeadlineMs(nodeId: string, rttMs?: number | null): number {
  return adaptiveDeadlineMs({
    rttMs: rttMs ?? lookupPeerRttMs(nodeId),
    factor: 8,
    minMs: 10_000,
    maxMs: 30_000,
  });
}

/** GET/HEAD 默认可重试；其余方法只有调用方明确要求才重试，且不超过失败切换的上限。 */
function forwardAttempts(idempotent: boolean, retry?: { attempts: number }): number {
  const requested = retry?.attempts;
  if (requested === undefined) return idempotent ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
  if (!Number.isFinite(requested)) return 1;
  return Math.min(Math.max(Math.trunc(requested), 1), HTTP_FAILOVER_MAX_ATTEMPTS);
}

/**
 * 转发到目标节点的凭证：分享公开面用 `share:<token>`（`vibeterm_sh_<nodeId>` cookie），
 * 登录前公开面不带凭证，其余用节点会话 cookie。
 */
function forwardedAuthFor(req: Request, nodeId: string, rest: string): string | null {
  if (isShareAccessPath(rest, req.method)) {
    const token = readShareCookie(req, nodeId);
    return token ? shareAuthValue(token) : null;
  }
  if (AUTH_SKIP.has(rest)) return null;
  return readNodeSessionCookie(parseCookies(req.headers.get('cookie')), nodeId);
}

export function getSelfRewrite(req: Request): string | null {
  return getMeshRequestContext(req).selfRewrite ?? null;
}

export function rewriteSelf(req: Request, localNodeId: string): Request | null {
  const url = new URL(req.url);
  const parsed = parseNodePrefix(url.pathname);
  if (!parsed) return null;
  if (parsed.nodeId !== MESH_VIA_SELF && parsed.nodeId !== localNodeId) return null;
  return rewriteRequest(req, parsed.rest + url.search);
}

function rewriteRequest(req: Request, rewrite: string): Request {
  const url = new URL(req.url);
  const q = rewrite.indexOf('?');
  url.pathname = q === -1 ? rewrite : rewrite.slice(0, q);
  url.search = q === -1 ? '' : rewrite.slice(q);
  const inner = new Request(url, req);
  setMeshRequestContext(inner, {
    ...getMeshRequestContext(req),
    via: MESH_VIA_SELF,
    selfRewrite: undefined,
  });
  return inner;
}

export class Forwarder {
  private readonly wsPumps: ForwardWsPumps;
  private readonly shareLoginQuota = new ShareLoginQuota();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
  private authRateLimits: AuthRateLimits | null;

  constructor(private readonly deps: ForwarderDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    const sink = deps.log ?? ((line: string) => console.info(line));
    this.log = (line) => sink(stamp(line));
    this.authRateLimits = deps.authRateLimits ?? null;
    this.wsPumps = new ForwardWsPumps({ ...deps, sleep: this.sleep, log: this.log });
  }

  handleForwardSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    this.wsPumps.handleForwardSocketMessage(ws, message);
  }

  handleForwardSocketDrain(ws: MeshServerWebSocket): void {
    this.wsPumps.handleForwardSocketDrain(ws);
  }

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    this.wsPumps.handleForwardSocketClose(ws, code, reason);
  }

  attachForwardPump(ws: MeshServerWebSocket, stream: OpenedWsStream | PendingForwardOpen): void {
    this.wsPumps.attachForwardPump(ws, stream);
  }

  setAuthRateLimits(limits: AuthRateLimits | null): void {
    this.authRateLimits = limits;
  }

  async handle(req: Request, server: MeshUpgradeServer): Promise<MeshHandleResult> {
    const url = new URL(req.url);
    const parsed = parseNodePrefix(url.pathname);
    if (!parsed) return null;
    if (this.isLocalNode(parsed.nodeId)) {
      return this.handleSelf(req, parsed.rest, url.search);
    }
    if (parsed.rest === '/ws') {
      return this.handleRemoteWs(req, server, parsed.nodeId);
    }
    if (parsed.rest === '/api' || parsed.rest.startsWith('/api/')) {
      if (parsed.rest.startsWith('/api/mesh-internal')) {
        return jsonError('FORBIDDEN', 403);
      }
      return this.handleRemoteHttp(req, parsed.nodeId, parsed.rest, url.search);
    }
    return null;
  }

  /**
   * peer 身份的节点间调用（`/api/mesh-internal/*`）。默认是一次性 JSON POST；
   * 需要搬字节时给 `rawBody`（只能读一次，续传由调用方按偏移重开）。
   */
  async forwardInternalHttp(
    nodeId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    input?: {
      method?: string;
      query?: string;
      headers?: Record<string, string>;
      rawBody?: ReadableStream<Uint8Array>;
      /** rawBody 的上行进度（累计已读字节），节流后回调。 */
      onProgress?: (uploadedBytes: number) => void;
    }
  ): Promise<Response> {
    const abort = signal ?? new AbortController().signal;
    const headers: Record<string, string> = { ...(input?.headers ?? {}) };
    let streamBody: ReadableStream<Uint8Array> | null;
    if (input?.rawBody) {
      let uploaded = 0;
      const progress = input.onProgress ? throttledProgress(input.onProgress) : null;
      streamBody = countStreamBytes(input.rawBody, (n) => {
        uploaded += n;
        progress?.(uploaded);
      });
    } else {
      const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      const bytes = new TextEncoder().encode(payload);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    const floorMs = forwardLinkDeadlineFor(nodeId, this.deps.peers.rttOf?.(nodeId));
    try {
      const link = await this.deps.peers.getLink(nodeId);
      return await withHttpStreamUploadDeadline(
        abort,
        floorMs,
        headers,
        Boolean(input?.rawBody),
        (s) =>
          this.deps.streams.openHttpStream(
            link,
            {
              method: input?.method ?? 'POST',
              path,
              query: input?.query ?? '',
              headers,
              origin: 'http://localhost',
              auth: null,
            },
            streamBody,
            s
          )
      );
    } catch (err) {
      // 传输层还没接手这个 body：不主动掐掉的话，源端的读取管道与文件句柄就没人再关了
      await cancelForwardBody(streamBody);
      return nodeUnreachableResponse(nodeId, abort.aborted, err);
    }
  }

  async forwardAuthorizedHttp(
    req: Request,
    input: {
      nodeId: string;
      method: string;
      path: string;
      query?: string;
      body?: unknown;
      rawBody?: ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      /**
       * 非幂等方法的显式重试授权：调用方确认这次转发重发一遍是安全的（如删除暂存包）。
       * 带 rawBody 的请求一律不重试——流只能读一次，重发要由调用方按偏移重建。
       */
      retry?: { attempts: number };
      /** rawBody 的上行进度（累计已读字节），节流后回调，用于长传的进度展示。 */
      onProgress?: (uploadedBytes: number) => void;
    },
    signal?: AbortSignal
  ): Promise<Response> {
    const auth = readNodeSessionCookie(parseCookies(req.headers.get('cookie')), input.nodeId);
    if (!auth) {
      return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId: input.nodeId });
    }
    const abort = input.signal ?? signal ?? req.signal;
    const method = input.method.toUpperCase();
    const idempotent = IDEMPOTENT_HTTP.has(method);
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    let uploaded = 0;
    const rawBody = idempotent ? null : (input.rawBody ?? null);
    const progress = input.onProgress ? throttledProgress(input.onProgress) : null;
    const countedRaw = rawBody
      ? countStreamBytes(rawBody, (n) => {
          uploaded += n;
          progress?.(uploaded);
        })
      : null;
    const attempts = rawBody ? 1 : forwardAttempts(idempotent, input.retry);
    const retryable = attempts > 1;
    // JSON 体每次尝试重建：ReadableStream 只能读一次，复用会让第二次 open 抛 locked。
    const nextBody = (): ReadableStream<Uint8Array> | null => {
      if (idempotent) return null;
      return countedRaw ?? buildJsonStreamBody(input.body, headers);
    };
    let lastError: unknown;
    const rttMs = this.deps.peers.rttOf?.(input.nodeId);
    const budgets = authorizedAttemptBudgetsMs({
      linkMs: forwardLinkDeadlineFor(input.nodeId, rttMs),
      overallMs: authorizedHttpDeadlineMs(input.nodeId, rttMs),
      headers,
      hasRawBody: Boolean(rawBody),
    });
    const deadlineAt = Date.now() + budgets.overallMs;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (abort.aborted || Date.now() >= deadlineAt) break;
      if (attempt > 0) {
        try {
          await this.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, abort);
        } catch {
          break;
        }
      }
      const remaining = deadlineAt - Date.now();
      try {
        return await runLinkThenTransfer({
          parent: abort,
          linkBudgetMs: Math.min(remaining, budgets.linkMs),
          transferBudgetMs: Math.min(remaining, budgets.transferMs),
          getLink: this.deps.peers.getLink(input.nodeId, { purpose: 'management' }),
          transfer: (link, signal) => {
            const origin = req.headers.get('origin') ?? new URL(req.url).origin;
            return this.deps.streams
              .openHttpStream(
                link,
                {
                  method,
                  path: input.path,
                  query: input.query ?? '',
                  headers,
                  origin,
                  auth,
                },
                nextBody(),
                signal
              )
              .then((res) => this.adaptResponse(req, res, input.nodeId));
          },
        });
      } catch (err) {
        lastError = err;
        if (rawBody) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[mesh][forward] raw-body push aborted node=${input.nodeId} bytes=${uploaded} err=${message}`
          );
        }
        if (!retryable) break;
      }
    }
    await cancelForwardBody(countedRaw);
    return nodeUnreachableResponse(
      input.nodeId,
      abort.aborted,
      lastError,
      rawBody && lastError !== undefined
        ? { error: lastError instanceof Error ? lastError.message : String(lastError) }
        : undefined
    );
  }

  private isLocalNode(id: string): boolean {
    return id === MESH_VIA_SELF || id === this.deps.nodeId;
  }

  private handleSelf(req: Request, rest: string, search: string) {
    const rewrite = rest + search;
    setMeshRequestContext(req, {
      ...getMeshRequestContext(req),
      via: MESH_VIA_SELF,
      selfRewrite: rewrite,
    });
    return { rewritten: rewriteRequest(req, rewrite) };
  }

  private async handleRemoteHttp(
    req: Request,
    nodeId: string,
    rest: string,
    search: string
  ): Promise<Response> {
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.forwardHttp(req, nodeId, rest, search, abort.signal);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 取链路，最多等到 deadline；超时抛 ForwardDeadlineError，未认领的链路留给下次复用。 */
  private async linkBefore(nodeId: string, deadlineAt: number, rest?: string) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ForwardDeadlineError();
    // 节点详情里的域名访问 / 直连插件等管理调用对已暂停节点也要能通
    const purpose = rest?.startsWith('/api/system/') ? 'management' : 'user';
    const pending = this.deps.peers.getLink(nodeId, { purpose });
    const timeout = new AbortController();
    const expired = this.sleep(remaining, timeout.signal).then(
      () => null,
      () => null
    );
    try {
      const link = await Promise.race([pending, expired]);
      if (link) return link;
      // 墙钟没真的走过 deadline（测试注入的零延时 sleep）：不认这次超时。
      if (Date.now() < deadlineAt) return await pending;
      void pending.catch(() => undefined);
      this.log(`[mesh] forward link deadline node=${nodeId} waited_ms=${remaining}`);
      throw new ForwardDeadlineError();
    } finally {
      timeout.abort();
    }
  }

  private async forwardHttp(
    req: Request,
    nodeId: string,
    rest: string,
    search: string,
    signal: AbortSignal
  ): Promise<Response> {
    const gated = await this.gateForwardedAuth(req, rest);
    if (gated.response) return gated.response;
    const headers = filterRequestHeaders(req);
    const auth = forwardedAuthFor(req, nodeId, rest);
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const retryable = IDEMPOTENT_HTTP.has(req.method);
    const body = retryable ? null : req.body;
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
    const floorMs = forwardLinkDeadlineFor(nodeId, this.deps.peers.rttOf?.(nodeId));
    const deadlineAt = Date.now() + floorMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted || Date.now() >= deadlineAt) break;
      if (attempt > 0) {
        try {
          await this.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, signal);
        } catch {
          break;
        }
      }
      try {
        const link = await this.linkBefore(nodeId, deadlineAt, rest);
        const upstream = await this.adaptResponse(
          req,
          await withHttpStreamUploadDeadline(signal, floorMs, headers, Boolean(body), (s) =>
            this.deps.streams.openHttpStream(
              link,
              { method: req.method, path: rest, query: search, headers, origin, auth },
              body,
              s
            )
          ),
          nodeId
        );
        await this.recordForwardedLoginFailure(gated, rest, upstream);
        return upstream;
      } catch (err) {
        lastError = err;
        if (!retryable || err instanceof ForwardDeadlineError) break;
      }
    }
    return nodeUnreachableResponse(nodeId, signal.aborted, lastError);
  }

  private async gateForwardedAuth(
    req: Request,
    rest: string
  ): Promise<{ response: Response | null; uidHint: string; ip: string; shareId?: string }> {
    const ip = clientIpFromRequest(req) ?? 'local';
    const empty = { response: null, uidHint: '', ip };
    const shareId = shareLoginShareId(req.method, rest);
    if (shareId) return { ...empty, shareId, response: this.gateShareLogin(shareId, ip) };
    const limits = this.authRateLimits;
    if (!limits) return empty;
    if (AUTH_CHALLENGE_PATHS.has(rest)) {
      return { response: limits.consumeChallengeQuota(req), uidHint: '', ip };
    }
    if (rest !== AUTH_LOGIN_PATH) return empty;
    let uidHint = '';
    try {
      const parsed = await readJsonObjectBody(req.clone());
      uidHint = parsed ? peekLoginUid(parsed) : '';
    } catch {
      uidHint = '';
    }
    if (uidHint && authUidTooLong(uidHint)) {
      return { response: jsonError('MALFORMED', 400), uidHint, ip };
    }
    if (limits.isLoginRateLimited(uidHint, ip)) {
      return { response: jsonError('RATE_LIMITED', 429), uidHint, ip };
    }
    return { response: null, uidHint, ip };
  }

  /** 分享登录：节点侧只看得到 `peer:<hubNodeId>`，配额必须在 Hub 这一侧按真实来源 IP 计。 */
  private gateShareLogin(shareId: string, ip: string): Response | null {
    const retryAfterMs = this.shareLoginQuota.lockedFor(shareId, ip);
    if (retryAfterMs <= 0) return null;
    this.log(`[mesh] share login locked share=${shareId} retry_after_ms=${retryAfterMs}`);
    return new Response(
      JSON.stringify({
        error: 'Too many failed attempts.',
        code: 'SHARE_LOGIN_LOCKED',
        retryAfterMs,
      }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(retryAfterMs / 1000)),
        },
      }
    );
  }

  private async recordForwardedLoginFailure(
    gated: { uidHint: string; ip: string; shareId?: string },
    rest: string,
    upstream: Response
  ): Promise<void> {
    if (gated.shareId) {
      if (upstream.status === 401) this.shareLoginQuota.recordFailure(gated.shareId, gated.ip);
      else if (upstream.ok) this.shareLoginQuota.reset(gated.shareId, gated.ip);
      return;
    }
    const limits = this.authRateLimits;
    if (!limits || rest !== AUTH_LOGIN_PATH || upstream.status !== 401) return;
    const code = await peekJsonCode(upstream.clone());
    if (code === 'TOTP_REQUIRED' || code === 'PASSKEY_REQUIRED') return;
    if (gated.uidHint && authUidTooLong(gated.uidHint)) return;
    limits.recordLoginFailure(gated.uidHint, gated.ip);
  }

  private handleRemoteWs(req: Request, server: MeshUpgradeServer, nodeId: string) {
    return upgradeRemoteWs(req, server, nodeId, {
      peers: this.deps.peers,
      streams: this.deps.streams,
      deadlineMs: forwardLinkDeadlineFor(nodeId, this.deps.peers.rttOf?.(nodeId)),
    });
  }

  private async adaptResponse(req: Request, upstream: Response, nodeId: string): Promise<Response> {
    const headers = copyUpstreamHeaders(upstream);
    const rest = parseNodePrefix(new URL(req.url).pathname)?.rest ?? '';
    return (
      (await applyAuthPolicy(
        req,
        headers,
        upstream,
        nodeId,
        AUTH_SKIP.has(rest) || isShareAccessPath(rest, req.method)
      )) ?? new Response(upstream.body, { status: upstream.status, headers })
    );
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
