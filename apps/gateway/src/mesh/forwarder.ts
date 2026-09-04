import { wsBorsh } from '@tmex/shared';
import { readJsonObjectBody } from '../api/http';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import { type AuthRateLimits, authUidTooLong, peekLoginUid } from './auth-routes';
import { clientIpFromRequest } from './client-ip';
import {
  AUTH_CHALLENGE_PATHS,
  AUTH_LOGIN_PATH,
  AUTH_SKIP,
  applyAuthPolicy,
  expireNodeCookieOn,
  peekJsonCode,
} from './forwarder-auth-policy';
import { type ForwardPump as FailoverPump, runStreamFailover } from './forwarder-failover';
import { copyUpstreamHeaders, filterRequestHeaders } from './forwarder-headers';
import { parseNodePrefix } from './forwarder-path';
import { nodeUnreachableResponse } from './forwarder-unreachable';
import { buildJsonStreamBody } from './json-stream-body';
import {
  HTTP_FAILOVER_MAX_ATTEMPTS,
  MESH_FORWARD_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_VIA_SELF,
  type MeshHandleResult,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_QUEUE_MAX_BYTES,
  STREAM_QUEUE_MAX_FRAMES,
  STREAM_QUEUE_OVERFLOW_REASON,
  type StreamOpener,
  getMeshRequestContext,
  setMeshRequestContext,
} from './mesh-deps';
import { stamp } from './mesh-log';
import { jsonError } from './session-middleware';
import { StreamReplayState, rejectStaleNodeStream } from './stream-replay-state';

type ForwarderDeps = {
  nodeId: string;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  authRateLimits?: AuthRateLimits | null;
};

type ForwardMeta = {
  nodeId: string;
  auth: string;
  cid?: string;
  transport: PeerTransportKind | null;
};

type ForwardPump = FailoverPump & {
  ws: MeshServerWebSocket;
  generation: number;
  browserPaused: boolean;
  inboundHold: Uint8Array[];
  inboundHoldBytes: number;
};

const pendingMeta = new WeakMap<OpenedWsStream, ForwardMeta>();
const IDEMPOTENT_HTTP = new Set(['GET', 'HEAD']);

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
  private readonly pumps = new Map<MeshServerWebSocket, ForwardPump>();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
  private authRateLimits: AuthRateLimits | null;

  constructor(private readonly deps: ForwarderDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    const sink = deps.log ?? ((line: string) => console.info(line));
    this.log = (line) => sink(stamp(line));
    this.authRateLimits = deps.authRateLimits ?? null;
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

  handleForwardSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    const pump = this.pumps.get(ws);
    if (!pump || pump.browserClosed) return;
    const bytes = toBytes(message);
    if (!bytes) return;
    pump.replay.noteOutbound(bytes);
    if (pump.failingOver || !pump.stream) {
      if (!enqueueFrame(pump, bytes)) this.failPump(pump, STREAM_QUEUE_OVERFLOW_REASON);
      return;
    }
    this.sendToStream(pump, pump.stream, bytes);
  }

  handleForwardSocketDrain(ws: MeshServerWebSocket): void {
    const pump = this.pumps.get(ws);
    if (!pump || pump.browserClosed) return;
    pump.browserPaused = false;
    this.flushInbound(pump);
  }

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    const pump = this.pumps.get(ws);
    this.pumps.delete(ws);
    if (!pump) {
      discardPendingStream(ws.data?.token);
      return;
    }
    pump.browserClosed = true;
    this.closePump(pump, { code, reason });
  }

  attachForwardPump(ws: MeshServerWebSocket, stream: OpenedWsStream): void {
    const meta = pendingMeta.get(stream);
    const pump: ForwardPump = {
      id: crypto.randomUUID().slice(0, 8),
      ws,
      nodeId: meta?.nodeId ?? ws.data.nodeId ?? '',
      auth: meta?.auth ?? ws.data.auth ?? '',
      cid: meta?.cid ?? ws.data.cid,
      stream: null,
      boundTransport: meta?.transport ?? null,
      replay: new StreamReplayState(),
      generation: 0,
      browserClosed: false,
      failingOver: false,
      failoverAbort: null,
      queue: [],
      helloWait: null,
      resumeWait: null,
      streamAlive: true,
      inflight: null,
      queueBytes: 0,
      browserPaused: false,
      inboundHold: [],
      inboundHoldBytes: 0,
    };
    this.pumps.set(ws, pump);
    this.bindStream(pump, stream, meta?.transport ?? null);
  }

  async forwardInternalHttp(
    nodeId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const abort = signal ?? new AbortController().signal;
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const bytes = new TextEncoder().encode(payload);
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    try {
      const link = await this.deps.peers.getLink(nodeId);
      return await this.deps.streams.openHttpStream(
        link,
        {
          method: 'POST',
          path,
          query: '',
          headers: { 'content-type': 'application/json' },
          origin: 'http://localhost',
          auth: null,
        },
        streamBody,
        abort
      );
    } catch (err) {
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
    },
    signal?: AbortSignal
  ): Promise<Response> {
    const auth =
      parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(input.nodeId)) ?? null;
    if (!auth) {
      return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId: input.nodeId });
    }
    const abort = input.signal ?? signal ?? req.signal;
    const method = input.method.toUpperCase();
    const retryable = IDEMPOTENT_HTTP.has(method);
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    let uploaded = 0;
    const rawBody = retryable ? null : (input.rawBody ?? null);
    const body = retryable
      ? null
      : rawBody
        ? countStreamBytes(rawBody, (n) => {
            uploaded += n;
          })
        : buildJsonStreamBody(input.body, headers);
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (abort.aborted) break;
      if (attempt > 0) {
        try {
          await this.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, abort);
        } catch {
          break;
        }
      }
      try {
        return await this.openAuthorizedAttempt(req, input, { method, headers, auth, body, abort });
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
    return nodeUnreachableResponse(
      input.nodeId,
      abort.aborted,
      lastError,
      rawBody && lastError !== undefined
        ? { error: lastError instanceof Error ? lastError.message : String(lastError) }
        : undefined
    );
  }

  private async openAuthorizedAttempt(
    req: Request,
    input: { nodeId: string; path: string; query?: string },
    opts: {
      method: string;
      headers: Record<string, string>;
      auth: string;
      body: ReadableStream<Uint8Array> | null;
      abort: AbortSignal;
    }
  ): Promise<Response> {
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const link = await this.deps.peers.getLink(input.nodeId);
    return await this.adaptResponse(
      req,
      await this.deps.streams.openHttpStream(
        link,
        {
          method: opts.method,
          path: input.path,
          query: input.query ?? '',
          headers: opts.headers,
          origin,
          auth: opts.auth,
        },
        opts.body,
        opts.abort
      ),
      input.nodeId
    );
  }

  private bindStream(
    pump: ForwardPump,
    stream: OpenedWsStream,
    transport: PeerTransportKind | null
  ): void {
    pump.generation += 1;
    const generation = pump.generation;
    pump.stream = stream;
    pump.boundTransport = transport;
    pump.streamAlive = true;
    stream.onMessage((bytes) => {
      if (generation !== pump.generation || pump.browserClosed) return;
      this.handleRemoteBytes(pump, bytes);
    });
    stream.onClose((info) => {
      if (generation !== pump.generation || pump.browserClosed) return;
      pump.streamAlive = false;
      pump.helloWait?.();
      pump.helloWait = null;
      if (pump.failingOver) return;
      void this.failover(pump, info ?? {});
    });
  }

  private handleRemoteBytes(pump: ForwardPump, bytes: Uint8Array): void {
    const noted = pump.replay.noteInbound(bytes);
    if (pump.resumeWait && pump.replay.isResumeReady()) {
      pump.resumeWait();
      pump.resumeWait = null;
    }
    if (noted.kind === wsBorsh.KIND_HELLO_S2C) {
      pump.helloWait?.();
      pump.helloWait = null;
      if (rejectStaleNodeStream(noted.peerUnsupported, pump, this)) return;
      if (pump.replay.helloForwarded) return;
      pump.replay.helloForwarded = true;
    }
    if (noted.kind === wsBorsh.KIND_DEVICE_CONNECTED && noted.deviceId) {
      if (pump.replay.connectedForwarded.has(noted.deviceId)) return;
      pump.replay.connectedForwarded.add(noted.deviceId);
    }
    this.sendToBrowser(pump, bytes);
  }

  sendToBrowser(pump: ForwardPump, bytes: Uint8Array): void {
    if (pump.browserClosed) return;
    if (pump.browserPaused) {
      if (!holdInbound(pump, bytes)) this.failPump(pump, STREAM_QUEUE_OVERFLOW_REASON);
      return;
    }
    let result: number | undefined;
    try {
      result = pump.ws.send(bytes);
    } catch {
      pump.stream?.close();
      return;
    }
    if (result === 0) {
      this.closeBrowser(pump, { code: 1011, reason: 'forward-ws-closed' });
      return;
    }
    if (result === -1) {
      pump.browserPaused = true;
    }
  }

  private flushInbound(pump: ForwardPump): void {
    while (!pump.browserPaused && !pump.browserClosed && pump.inboundHold.length > 0) {
      const next = pump.inboundHold.shift();
      if (!next) break;
      pump.inboundHoldBytes = Math.max(0, pump.inboundHoldBytes - next.byteLength);
      this.sendToBrowser(pump, next);
    }
  }

  private async failover(
    pump: ForwardPump,
    info: { code?: number; reason?: string }
  ): Promise<void> {
    await runStreamFailover(
      {
        sleep: this.sleep,
        log: this.log,
        peers: this.deps.peers,
        streams: this.deps.streams,
        bindStream: (p, stream, transport) => this.bindStream(p as ForwardPump, stream, transport),
        discardStream: (p, stream) => this.discardStream(p as ForwardPump, stream),
        closePump: (p, closeInfo) => this.closePump(p as ForwardPump, closeInfo),
        sendToStream: (p, stream, bytes) => this.sendToStream(p as ForwardPump, stream, bytes),
        sendToBrowser: (p, bytes) => this.sendToBrowser(p as ForwardPump, bytes),
        flushQueue: (p) => this.flushQueue(p as ForwardPump),
      },
      pump,
      info
    );
  }

  private flushQueue(pump: ForwardPump): void {
    const queued = pump.queue.splice(0);
    pump.queueBytes = 0;
    const stream = pump.stream;
    if (!stream) return;
    for (const bytes of queued) {
      const out = pump.replay.rewriteQueuedFrame(bytes);
      if (out) this.sendToStream(pump, stream, out);
    }
  }

  private sendToStream(pump: ForwardPump, stream: OpenedWsStream, bytes: Uint8Array): void {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(stream.send(bytes));
    } catch {
      this.onSendFailed(pump, stream);
      return;
    }
    void pending.then(undefined, () => this.onSendFailed(pump, stream));
  }

  private onSendFailed(pump: ForwardPump, stream: OpenedWsStream): void {
    if (pump.browserClosed || pump.stream !== stream) return;
    pump.streamAlive = false;
    try {
      stream.close(1011, 'send-failed');
    } catch {}
    if (pump.failingOver) return;
    void this.failover(pump, { code: 1011, reason: 'send-failed' });
  }

  private failPump(pump: ForwardPump, reason: string): void {
    this.closePump(pump, { code: 1011, reason });
  }

  /** 整条转发流拆解：先断上游（当前流 + 在途流），再断浏览器，避免留下无主的 mesh 流。 */
  closePump(pump: ForwardPump, info: { code?: number; reason?: string }): void {
    pump.failoverAbort?.abort();
    pump.helloWait?.();
    pump.helloWait = null;
    pump.resumeWait?.();
    pump.resumeWait = null;
    const inflight = pump.inflight;
    pump.inflight = null;
    inflight?.close(info.code, info.reason);
    pump.stream?.close(info.code, info.reason);
    pump.stream = null;
    pump.streamAlive = false;
    this.closeBrowser(pump, info);
  }

  private discardStream(pump: ForwardPump, stream: OpenedWsStream): void {
    if (pump.inflight === stream) pump.inflight = null;
    if (pump.stream === stream) {
      pump.stream = null;
      pump.streamAlive = false;
    }
    try {
      stream.close();
    } catch {}
  }

  closeBrowser(pump: ForwardPump, info: { code?: number; reason?: string }): void {
    if (pump.browserClosed) return;
    pump.browserClosed = true;
    this.pumps.delete(pump.ws);
    try {
      pump.ws.close(info.code, info.reason);
    } catch {}
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
    const auth = AUTH_SKIP.has(rest)
      ? null
      : (parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null);
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const retryable = IDEMPOTENT_HTTP.has(req.method);
    const body = retryable ? null : req.body;
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) break;
      if (attempt > 0) {
        try {
          await this.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, signal);
        } catch {
          break;
        }
      }
      try {
        const link = await this.deps.peers.getLink(nodeId);
        const upstream = await this.adaptResponse(
          req,
          await this.deps.streams.openHttpStream(
            link,
            { method: req.method, path: rest, query: search, headers, origin, auth },
            body,
            signal
          ),
          nodeId
        );
        await this.recordForwardedLoginFailure(gated, rest, upstream);
        return upstream;
      } catch (err) {
        lastError = err;
        if (!retryable) break;
      }
    }
    return nodeUnreachableResponse(nodeId, signal.aborted, lastError);
  }

  private async gateForwardedAuth(
    req: Request,
    rest: string
  ): Promise<{ response: Response | null; uidHint: string; ip: string }> {
    const ip = clientIpFromRequest(req) ?? 'local';
    const empty = { response: null, uidHint: '', ip };
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

  private async recordForwardedLoginFailure(
    gated: { uidHint: string; ip: string },
    rest: string,
    upstream: Response
  ): Promise<void> {
    const limits = this.authRateLimits;
    if (!limits || rest !== AUTH_LOGIN_PATH || upstream.status !== 401) return;
    const code = await peekJsonCode(upstream.clone());
    if (code === 'TOTP_REQUIRED' || code === 'PASSKEY_REQUIRED') return;
    if (gated.uidHint && authUidTooLong(gated.uidHint)) return;
    limits.recordLoginFailure(gated.uidHint, gated.ip);
  }

  private async handleRemoteWs(
    req: Request,
    server: MeshUpgradeServer,
    nodeId: string
  ): Promise<Response | undefined> {
    const auth = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null;
    if (!auth) {
      const upgraded = server.upgrade(req, {
        data: { kind: MESH_REJECT_4401_KIND, nodeId, auth: null },
      });
      return upgraded
        ? undefined
        : expireNodeCookieOn(
            req,
            nodeId,
            jsonError('UNAUTHORIZED', 401, { code: 'NODE_LOGIN_REQUIRED', nodeId })
          );
    }
    if (req.signal.aborted) {
      return nodeUnreachableResponse(nodeId, true);
    }
    let linkError: unknown;
    const link = await this.deps.peers.getLink(nodeId).catch((err) => {
      linkError = err;
      return null;
    });
    if (!link || req.signal.aborted) {
      return nodeUnreachableResponse(nodeId, req.signal.aborted, linkError);
    }
    const cid = new URL(req.url).searchParams.get('cid')?.trim() || undefined;
    let streamError: unknown;
    const stream = await this.deps.streams.openWsStream(link, auth, cid).catch((err) => {
      streamError = err;
      return null;
    });
    if (!stream) {
      return nodeUnreachableResponse(nodeId, false, streamError);
    }
    if (req.signal.aborted) {
      stream.close();
      return nodeUnreachableResponse(nodeId, true);
    }
    const token = crypto.randomUUID();
    pendingStreams.set(token, stream);
    pendingMeta.set(stream, {
      nodeId,
      auth,
      cid,
      transport: this.deps.peers.transportOf?.(nodeId) ?? null,
    });
    const ok = server.upgrade(req, {
      data: { kind: MESH_FORWARD_WS_KIND, nodeId, auth, token, cid },
    });
    if (!ok) {
      pendingStreams.delete(token);
      stream.close();
      return jsonError('upgrade_failed', 500);
    }
    if (pendingStreams.get(token) === stream) armPendingExpiry(token, stream);
    return undefined;
  }

  private async adaptResponse(req: Request, upstream: Response, nodeId: string): Promise<Response> {
    const headers = copyUpstreamHeaders(upstream);
    const rest = parseNodePrefix(new URL(req.url).pathname)?.rest ?? '';
    return (
      (await applyAuthPolicy(req, headers, upstream, nodeId, AUTH_SKIP.has(rest))) ??
      new Response(upstream.body, { status: upstream.status, headers })
    );
  }
}

const pendingStreams = new Map<string, OpenedWsStream>();
const pendingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
export const DEFAULT_PENDING_FORWARD_STREAM_TTL_MS = 60_000;
let pendingForwardStreamTtlMs = DEFAULT_PENDING_FORWARD_STREAM_TTL_MS;

export function setPendingForwardStreamTtlMs(ms: number): void {
  pendingForwardStreamTtlMs = ms;
}

export function pendingForwardStreamCount(): number {
  return pendingStreams.size;
}

export function takePendingForwardStream(token: string | undefined): OpenedWsStream | undefined {
  if (!token) return undefined;
  const stream = pendingStreams.get(token);
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  return stream;
}

function discardPendingStream(token: string | undefined): void {
  if (!token) return;
  const stream = pendingStreams.get(token);
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  if (!stream) return;
  try {
    stream.close();
  } catch {}
}

function clearPendingExpiry(token: string): void {
  const timer = pendingExpiry.get(token);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingExpiry.delete(token);
}

function armPendingExpiry(token: string, stream: OpenedWsStream): void {
  const timer = setTimeout(() => {
    expirePendingForwardStream(token, stream);
  }, pendingForwardStreamTtlMs);
  timer.unref?.();
  pendingExpiry.set(token, timer);
}

export function expirePendingForwardStream(token: string, stream: OpenedWsStream): void {
  if (pendingStreams.get(token) !== stream) return;
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  try {
    stream.close();
  } catch {}
}

function holdInbound(pump: ForwardPump, bytes: Uint8Array): boolean {
  if (
    pump.inboundHold.length >= STREAM_QUEUE_MAX_FRAMES ||
    pump.inboundHoldBytes + bytes.byteLength > STREAM_QUEUE_MAX_BYTES
  ) {
    return false;
  }
  pump.inboundHold.push(bytes.slice());
  pump.inboundHoldBytes += bytes.byteLength;
  return true;
}

function enqueueFrame(pump: ForwardPump, bytes: Uint8Array): boolean {
  if (
    pump.queue.length >= STREAM_QUEUE_MAX_FRAMES ||
    pump.queueBytes + bytes.byteLength > STREAM_QUEUE_MAX_BYTES
  ) {
    return false;
  }
  pump.queue.push(bytes.slice());
  pump.queueBytes += bytes.byteLength;
  return true;
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

function countStreamBytes(
  body: ReadableStream<Uint8Array>,
  onBytes: (n: number) => void
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    })
  );
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}
