import { wsBorsh } from '@tmex/shared';
import { buildSetCookie, nodeSessionCookieName, parseCookies } from '../auth/cookies';
import { buildJsonStreamBody } from './json-stream-body';
import {
  AUTH_401_BODY_LIMIT,
  HTTP_FAILOVER_MAX_ATTEMPTS,
  MESH_ALLOWED_MIME,
  MESH_FORWARD_CSP,
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
  STREAM_FAILOVER_MAX_ATTEMPTS,
  STREAM_FAILOVER_RESUME_WAIT_MS,
  STREAM_QUEUE_MAX_BYTES,
  STREAM_QUEUE_MAX_FRAMES,
  STREAM_QUEUE_OVERFLOW_REASON,
  type StreamOpener,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  parseSetSessionHeader,
  setMeshRequestContext,
} from './mesh-deps';
import { isHttps, jsonError } from './session-middleware';
import { StreamReplayState } from './stream-replay-state';

const AUTH_SKIP = new Set(['/api/auth/challenge', '/api/auth/login']);
const RESPONSE_ALLOW = new Set([
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
]);
const DROP_ON_401_REWRITE = new Set([
  'content-length',
  'content-range',
  'etag',
  'content-disposition',
]);
const DROP_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'connection',
  'upgrade',
  'cf-connecting-ip',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
  'cf-ray',
]);

type ForwarderDeps = {
  nodeId: string;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
};

type ForwardMeta = {
  nodeId: string;
  auth: string;
  cid?: string;
  transport: PeerTransportKind | null;
};

type ForwardPump = {
  id: string;
  ws: MeshServerWebSocket;
  nodeId: string;
  auth: string;
  cid?: string;
  stream: OpenedWsStream | null;
  boundTransport: PeerTransportKind | null;
  replay: StreamReplayState;
  generation: number;
  browserClosed: boolean;
  failingOver: boolean;
  failoverAbort: AbortController | null;
  queue: Uint8Array[];
  helloWait: (() => void) | null;
  resumeWait: (() => void) | null;
  streamAlive: boolean;
  inflight: OpenedWsStream | null;
  queueBytes: number;
};

const pendingMeta = new WeakMap<OpenedWsStream, ForwardMeta>();
const IDEMPOTENT_HTTP = new Set(['GET', 'HEAD']);

export function getSelfRewrite(req: Request): string | null {
  return getMeshRequestContext(req).selfRewrite ?? null;
}

function parseNodePrefix(pathname: string): { nodeId: string; rest: string } | null {
  const match = pathname.match(/^\/n\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return { nodeId: decodeURIComponent(match[1] ?? ''), rest: match[2] || '/' };
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
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ForwarderDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((line) => console.info(line));
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

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    const pump = this.pumps.get(ws);
    this.pumps.delete(ws);
    if (!pump) {
      discardPendingStream(ws.data?.token);
      return;
    }
    pump.browserClosed = true;
    pump.failoverAbort?.abort();
    pump.helloWait?.();
    pump.helloWait = null;
    pump.resumeWait?.();
    pump.resumeWait = null;
    const inflight = pump.inflight;
    pump.inflight = null;
    inflight?.close(code, reason);
    pump.stream?.close(code, reason);
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
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
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
    const body = retryable ? null : (input.rawBody ?? buildJsonStreamBody(input.body, headers));
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
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
      } catch {
        if (!retryable) break;
      }
    }
    return jsonError('NODE_UNREACHABLE', 503, { nodeId: input.nodeId });
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
      void this.failover(pump, info);
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
      if (pump.replay.helloForwarded) return;
      pump.replay.helloForwarded = true;
    }
    if (noted.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      const deviceId = noted.deviceId;
      if (deviceId && pump.replay.connectedForwarded.has(deviceId)) return;
      if (deviceId) pump.replay.connectedForwarded.add(deviceId);
    }
    try {
      pump.ws.send(bytes);
    } catch {
      pump.stream?.close();
    }
  }

  private async failover(
    pump: ForwardPump,
    _info: { code?: number; reason?: string }
  ): Promise<void> {
    if (pump.browserClosed || pump.failingOver) return;
    pump.failingOver = true;
    pump.stream = null;
    const from = pump.boundTransport ?? 'none';
    const abort = new AbortController();
    pump.failoverAbort = abort;
    try {
      for (let attempt = 0; attempt < STREAM_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
        const stream = await this.openFailoverStream(pump, abort.signal, attempt);
        if (stream === 'aborted') return;
        if (!stream) continue;
        if (await this.completeFailover(pump, stream, from, abort.signal)) return;
      }
      this.closeBrowser(pump, { code: 1011, reason: 'failover-exhausted' });
    } finally {
      if (pump.failingOver) {
        pump.failingOver = false;
        pump.failoverAbort = null;
      }
    }
  }

  private async openFailoverStream(
    pump: ForwardPump,
    signal: AbortSignal,
    attempt: number
  ): Promise<OpenedWsStream | null | 'aborted'> {
    if (pumpDead(pump, signal)) return 'aborted';
    const delay = STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 1600;
    if (delay > 0) {
      try {
        await this.sleep(delay, signal);
      } catch {
        return 'aborted';
      }
    }
    if (pumpDead(pump, signal)) return 'aborted';
    const link = await this.deps.peers.getLink(pump.nodeId).catch(() => null);
    if (pumpDead(pump, signal)) return 'aborted';
    if (!link) return null;
    const transport = this.deps.peers.transportOf?.(pump.nodeId) ?? null;
    const stream = await this.deps.streams
      .openWsStream(link, pump.auth, pump.cid)
      .catch(() => null);
    if (!stream) return pumpDead(pump, signal) ? 'aborted' : null;
    pump.inflight = stream;
    if (pumpDead(pump, signal)) {
      this.discardStream(pump, stream);
      return 'aborted';
    }
    this.bindStream(pump, stream, transport);
    pump.inflight = null;
    return stream;
  }

  private async completeFailover(
    pump: ForwardPump,
    stream: OpenedWsStream,
    from: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const resumed = await this.replaySubscription(pump, stream, signal);
    if (pumpDead(pump, signal)) {
      this.discardStream(pump, stream);
      return true;
    }
    if (!pump.streamAlive || pump.stream !== stream) return false;
    const desc = pump.replay.describeReplay();
    this.log(
      `[mesh][stream] failover stream=${pump.id} from=${from} to=${pump.boundTransport ?? 'none'} resumed=${resumed} mode=${desc.mode} panes=${desc.panes} cursor=${desc.cursor}`
    );
    pump.failingOver = false;
    pump.failoverAbort = null;
    this.flushQueue(pump);
    return true;
  }

  private async replaySubscription(
    pump: ForwardPump,
    stream: OpenedWsStream,
    signal: AbortSignal
  ): Promise<number> {
    pump.replay.beginResume();
    const wait = async (key: 'helloWait' | 'resumeWait', ms: number, before?: () => void) => {
      const waited = new Promise<void>((resolve) => {
        pump[key] = resolve;
      });
      before?.();
      await Promise.race([waited, this.sleep(ms, signal).catch(() => undefined)]);
      pump[key] = null;
    };
    const hello = pump.replay.hello;
    if (hello) await wait('helloWait', 2_000, () => this.sendToStream(pump, stream, hello));
    const sendAll = (frames: Uint8Array[]): void => {
      for (const frame of frames) {
        if (pumpDead(pump, signal)) return;
        this.sendToStream(pump, stream, frame);
      }
    };
    sendAll(pump.replay.buildConnectFrames());
    if (pump.replay.devices.size > 0 && !pump.replay.isResumeReady()) {
      await wait('resumeWait', STREAM_FAILOVER_RESUME_WAIT_MS);
    }
    sendAll(pump.replay.buildPostConnectFrames());
    if (!pumpDead(pump, signal)) pump.replay.markCanonicalResumeSent();
    return pump.replay.resumedPaneCount();
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
    if (pump.browserClosed) return;
    pump.failoverAbort?.abort();
    pump.helloWait?.();
    pump.helloWait = null;
    pump.resumeWait?.();
    pump.resumeWait = null;
    const inflight = pump.inflight;
    pump.inflight = null;
    inflight?.close(1011, reason);
    pump.stream?.close(1011, reason);
    this.closeBrowser(pump, { code: 1011, reason });
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

  private closeBrowser(pump: ForwardPump, info: { code?: number; reason?: string }): void {
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
    const headers = filterRequestHeaders(req);
    const auth = AUTH_SKIP.has(rest)
      ? null
      : (parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null);
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const retryable = IDEMPOTENT_HTTP.has(req.method);
    const body = retryable ? null : req.body;
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
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
        return await this.adaptResponse(
          req,
          await this.deps.streams.openHttpStream(
            link,
            { method: req.method, path: rest, query: search, headers, origin, auth },
            body,
            signal
          ),
          nodeId
        );
      } catch {
        if (!retryable) break;
      }
    }
    return jsonError('NODE_UNREACHABLE', 503, { nodeId });
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
        : jsonError('UNAUTHORIZED', 401, { code: 'NODE_LOGIN_REQUIRED', nodeId });
    }
    if (req.signal.aborted) return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    const link = await this.deps.peers.getLink(nodeId).catch(() => null);
    if (!link || req.signal.aborted) return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    const cid = new URL(req.url).searchParams.get('cid')?.trim() || undefined;
    const stream = await this.deps.streams.openWsStream(link, auth, cid).catch(() => null);
    if (!stream) return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    if (req.signal.aborted) {
      stream.close();
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
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
    return (
      (await applyAuthPolicy(req, headers, upstream, nodeId)) ??
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

function pumpDead(pump: ForwardPump, signal: AbortSignal): boolean {
  return pump.browserClosed || signal.aborted;
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

function copyUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  let contentType = '';
  let contentDisposition: string | null = null;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === X_TMEX_SET_SESSION) return;
    if (lower === 'content-type') {
      contentType = value;
      return;
    }
    if (lower === 'content-disposition') {
      contentDisposition = value;
      return;
    }
    if (RESPONSE_ALLOW.has(lower) || lower.startsWith('x-tmex-')) headers.set(key, value);
  });
  const mime = baseMime(contentType);
  if (mime && MESH_ALLOWED_MIME.has(mime)) {
    headers.set('content-type', contentType || mime);
    if (contentDisposition) headers.set('content-disposition', contentDisposition);
  } else {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', 'attachment');
  }
  headers.set('content-security-policy', MESH_FORWARD_CSP);
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

async function applyAuthPolicy(
  req: Request,
  headers: Headers,
  upstream: Response,
  nodeId: string
): Promise<Response | null> {
  const parsed = parseSetSessionHeader(upstream.headers.get(X_TMEX_SET_SESSION) ?? '');
  if (parsed) appendNodeCookie(req, headers, nodeId, parsed.sid, parsed.maxAgeSec);
  const renewed = upstream.headers.get(X_TMEX_SESSION_RENEWED);
  if (renewed) {
    headers.set(X_TMEX_SESSION_RENEWED, renewed);
    const sid = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId));
    const expiresAt = Number(renewed);
    if (sid && Number.isFinite(expiresAt)) {
      appendNodeCookie(
        req,
        headers,
        nodeId,
        sid,
        Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      );
    }
  }
  if (upstream.status !== 401) return null;
  const raw = await readBodyLimited(upstream, AUTH_401_BODY_LIMIT);
  let body: Record<string, unknown> = { code: 'NODE_LOGIN_REQUIRED', nodeId };
  try {
    const parsedBody = JSON.parse(raw) as unknown;
    if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)) {
      body = { ...(parsedBody as Record<string, unknown>), code: 'NODE_LOGIN_REQUIRED', nodeId };
    }
  } catch {
    if (raw) body.message = raw;
  }
  for (const name of DROP_ON_401_REWRITE) headers.delete(name);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: 401, headers });
}

function appendNodeCookie(
  req: Request,
  headers: Headers,
  nodeId: string,
  sid: string,
  maxAgeSec: number
): void {
  headers.append(
    'set-cookie',
    buildSetCookie(nodeSessionCookieName(nodeId), sid, { maxAgeSec, secure: isHttps(req) })
  );
}

function filterRequestHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      DROP_REQUEST_HEADERS.has(lower) ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-forwarded-')
    ) {
      return;
    }
    out[key] = value;
  });
  return out;
}

function baseMime(contentType: string): string {
  return contentType.trim().toLowerCase().split(';')[0]?.trim() ?? '';
}

async function readBodyLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, limit - total);
      if (take <= 0) {
        await reader.cancel();
        break;
      }
      chunks.push(take < value.byteLength ? value.subarray(0, take) : value);
      total += take;
      if (take < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    try {
      await reader.cancel();
    } catch {}
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
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

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}
