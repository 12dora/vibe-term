import { wsBorsh } from '@tmex/shared';
import type { LinkSession } from '@tmex/shared/link';
import { buildSetCookie, nodeSessionCookieName, parseCookies } from '../auth/cookies';
import {
  AUTH_401_BODY_LIMIT,
  HTTP_FAILOVER_MAX_ATTEMPTS,
  MESH_ALLOWED_MIME,
  MESH_FORWARD_CSP,
  MESH_FORWARD_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_VIA_SELF,
  type MeshHandleResult,
  type MeshRewritten,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_FAILOVER_MAX_ATTEMPTS,
  STREAM_FAILOVER_RESUME_WAIT_MS,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  parseSetSessionHeader,
  setMeshRequestContext,
} from './mesh-deps';
import { isHttps, jsonError } from './session-middleware';

const AUTH_SKIP = new Set(['/api/auth/challenge', '/api/auth/login']);

const RESPONSE_ALLOW = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'content-disposition',
]);

const DROP_ON_401_REWRITE = new Set([
  'content-length',
  'content-range',
  'etag',
  'content-disposition',
]);

export type ForwarderDeps = {
  nodeId: string;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
};

export type ForwardResult = MeshHandleResult;

type ForwardMeta = {
  nodeId: string;
  auth: string;
  cid?: string;
  link: LinkSession;
  transport: PeerTransportKind | null;
};

type ForwardPump = {
  id: string;
  ws: MeshServerWebSocket;
  nodeId: string;
  auth: string;
  cid?: string;
  stream: OpenedWsStream | null;
  boundLink: LinkSession | null;
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
};

const pendingMeta = new WeakMap<OpenedWsStream, ForwardMeta>();
const IDEMPOTENT_HTTP = new Set(['GET', 'HEAD']);

const selfRewrites = new WeakMap<Request, string>();

export function getSelfRewrite(req: Request): string | null {
  return selfRewrites.get(req) ?? getMeshRequestContext(req).selfRewrite ?? null;
}

export function parseNodePrefix(pathname: string): { nodeId: string; rest: string } | null {
  const match = pathname.match(/^\/n\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const nodeId = decodeURIComponent(match[1] ?? '');
  const rest = match[2] && match[2].length > 0 ? match[2] : '/';
  return { nodeId, rest };
}

export function rewriteSelf(req: Request, localNodeId: string): Request | null {
  const url = new URL(req.url);
  const parsed = parseNodePrefix(url.pathname);
  if (!parsed) return null;
  if (parsed.nodeId !== MESH_VIA_SELF && parsed.nodeId !== localNodeId) return null;
  return rewriteRequest(req, parsed.rest + url.search);
}

export function rewriteRequest(req: Request, rewrite: string): Request {
  const url = new URL(req.url);
  const q = rewrite.indexOf('?');
  if (q === -1) {
    url.pathname = rewrite;
    url.search = '';
  } else {
    url.pathname = rewrite.slice(0, q);
    url.search = rewrite.slice(q);
  }
  const inner = new Request(url, req);
  const ctx = getMeshRequestContext(req);
  setMeshRequestContext(inner, { ...ctx, via: MESH_VIA_SELF, selfRewrite: undefined });
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

  async handle(req: Request, server: MeshUpgradeServer): Promise<ForwardResult> {
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
      return this.handleRemoteHttp(req, parsed.nodeId, parsed.rest, url.search);
    }
    return null;
  }

  handleForwardSocketOpen(ws: MeshServerWebSocket): void {
    void ws;
  }

  handleForwardSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    const pump = this.pumps.get(ws);
    if (!pump || pump.browserClosed) return;
    const bytes = toBytes(message);
    if (!bytes) return;
    pump.replay.noteOutbound(bytes);
    if (pump.failingOver || !pump.stream) {
      pump.queue.push(bytes.slice());
      return;
    }
    pump.stream.send(bytes);
  }

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    const pump = this.pumps.get(ws);
    this.pumps.delete(ws);
    if (!pump) return;
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
      boundLink: meta?.link ?? null,
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
    };
    this.pumps.set(ws, pump);
    this.bindStream(pump, stream, meta?.link ?? null, meta?.transport ?? null);
  }

  private bindStream(
    pump: ForwardPump,
    stream: OpenedWsStream,
    link: LinkSession | null,
    transport: PeerTransportKind | null
  ): void {
    pump.generation += 1;
    const generation = pump.generation;
    pump.stream = stream;
    pump.boundLink = link;
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
    pump.replay.noteInbound(bytes);
    if (pump.resumeWait && pump.replay.isResumeReady()) {
      pump.resumeWait();
      pump.resumeWait = null;
    }
    let kind: number | null = null;
    try {
      kind = wsBorsh.decodeEnvelope(bytes).kind;
    } catch {
      kind = null;
    }
    if (kind === wsBorsh.KIND_HELLO_S2C) {
      pump.helloWait?.();
      pump.helloWait = null;
      if (pump.replay.helloForwarded) return;
      pump.replay.helloForwarded = true;
    }
    if (kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      const deviceId = pump.replay.noteDeviceConnected(bytes);
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
    const signal = abort.signal;
    try {
      for (let attempt = 0; attempt < STREAM_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
        if (pump.browserClosed || signal.aborted) return;
        const delay = STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 1600;
        if (delay > 0) {
          try {
            await this.sleep(delay, signal);
          } catch {
            return;
          }
        }
        if (pump.browserClosed || signal.aborted) return;
        let link: LinkSession;
        try {
          link = await this.deps.peers.getLink(pump.nodeId);
        } catch {
          continue;
        }
        if (pump.browserClosed || signal.aborted) return;
        const transport = this.deps.peers.transportOf?.(pump.nodeId) ?? null;
        let stream: OpenedWsStream;
        try {
          stream = await this.deps.streams.openWsStream(link, pump.auth, pump.cid);
        } catch {
          continue;
        }
        pump.inflight = stream;
        if (pump.browserClosed || signal.aborted) {
          this.discardStream(pump, stream);
          return;
        }
        this.bindStream(pump, stream, link, transport);
        pump.inflight = null;
        const resumed = await this.replaySubscription(pump, stream, signal);
        if (pump.browserClosed || signal.aborted) {
          this.discardStream(pump, stream);
          return;
        }
        if (!pump.streamAlive || pump.stream !== stream) continue;
        const to = transport ?? 'none';
        const desc = pump.replay.describeReplay();
        this.log(
          `[mesh][stream] failover stream=${pump.id} from=${from} to=${to} resumed=${resumed} mode=${desc.mode} panes=${desc.panes} cursor=${desc.cursor}`
        );
        pump.failingOver = false;
        pump.failoverAbort = null;
        this.flushQueue(pump);
        return;
      }
      this.closeBrowser(pump, { code: 1011, reason: 'failover-exhausted' });
    } finally {
      if (pump.failingOver) {
        pump.failingOver = false;
        pump.failoverAbort = null;
      }
    }
  }

  private async replaySubscription(
    pump: ForwardPump,
    stream: OpenedWsStream,
    signal: AbortSignal
  ): Promise<number> {
    pump.replay.beginResume();
    const hello = pump.replay.hello;
    if (hello) {
      const waited = new Promise<void>((resolve) => {
        pump.helloWait = resolve;
      });
      stream.send(hello);
      await Promise.race([waited, this.sleep(2_000, signal).catch(() => undefined)]);
      pump.helloWait = null;
    }
    for (const frame of pump.replay.buildConnectFrames()) {
      if (signal.aborted || pump.browserClosed) break;
      stream.send(frame);
    }
    if (pump.replay.devices.size > 0 && !pump.replay.isResumeReady()) {
      const waited = new Promise<void>((resolve) => {
        pump.resumeWait = resolve;
      });
      await Promise.race([
        waited,
        this.sleep(STREAM_FAILOVER_RESUME_WAIT_MS, signal).catch(() => undefined),
      ]);
      pump.resumeWait = null;
    }
    for (const frame of pump.replay.buildPostConnectFrames()) {
      if (signal.aborted || pump.browserClosed) break;
      stream.send(frame);
    }
    if (!signal.aborted && !pump.browserClosed) {
      pump.replay.markCanonicalResumeSent();
    }
    return pump.replay.resumedPaneCount();
  }

  private flushQueue(pump: ForwardPump): void {
    const queued = pump.queue.splice(0);
    const stream = pump.stream;
    if (!stream) return;
    for (const bytes of queued) {
      const out = pump.replay.rewriteQueuedFrame(bytes);
      if (out) stream.send(out);
    }
  }

  private discardStream(pump: ForwardPump, stream: OpenedWsStream): void {
    if (pump.inflight === stream) pump.inflight = null;
    if (pump.stream === stream) {
      pump.stream = null;
      pump.streamAlive = false;
    }
    try {
      stream.close();
    } catch {
      // already closed
    }
  }

  private closeBrowser(pump: ForwardPump, info: { code?: number; reason?: string }): void {
    if (pump.browserClosed) return;
    pump.browserClosed = true;
    this.pumps.delete(pump.ws);
    try {
      pump.ws.close(info.code, info.reason);
    } catch {
      // already closed
    }
  }

  private isLocalNode(id: string): boolean {
    return id === MESH_VIA_SELF || id === this.deps.nodeId;
  }

  private handleSelf(req: Request, rest: string, search: string): MeshRewritten {
    const rewrite = rest + search;
    selfRewrites.set(req, rewrite);
    const ctx = getMeshRequestContext(req);
    setMeshRequestContext(req, { ...ctx, via: MESH_VIA_SELF, selfRewrite: rewrite });
    return { rewritten: rewriteRequest(req, rewrite) };
  }

  private async handleRemoteHttp(
    req: Request,
    nodeId: string,
    rest: string,
    search: string
  ): Promise<Response> {
    const headers = filterRequestHeaders(req);
    const auth = AUTH_SKIP.has(stripQuery(rest))
      ? null
      : (parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null);
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    const body = req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null;
    const retryable = IDEMPOTENT_HTTP.has(req.method) && !body;
    const attempts = retryable ? HTTP_FAILOVER_MAX_ATTEMPTS : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (abort.signal.aborted) break;
        if (attempt > 0) {
          try {
            await this.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, abort.signal);
          } catch {
            break;
          }
        }
        let link: LinkSession;
        try {
          link = await this.deps.peers.getLink(nodeId);
        } catch {
          if (!retryable) break;
          continue;
        }
        try {
          return this.adaptResponse(
            req,
            await this.deps.streams.openHttpStream(
              link,
              { method: req.method, path: rest, query: search, headers, origin, auth },
              body,
              abort.signal
            ),
            nodeId
          );
        } catch {
          if (!retryable) break;
        }
      }
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
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
      if (!upgraded) {
        return jsonError('UNAUTHORIZED', 401, { code: 'NODE_LOGIN_REQUIRED', nodeId });
      }
      return undefined;
    }
    if (req.signal.aborted) {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    let link: LinkSession;
    try {
      link = await this.deps.peers.getLink(nodeId);
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    if (req.signal.aborted) {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    const cid = new URL(req.url).searchParams.get('cid')?.trim() || '';
    let stream: OpenedWsStream;
    try {
      stream = await this.deps.streams.openWsStream(link, auth, cid || undefined);
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    if (req.signal.aborted) {
      stream.close();
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    const token = crypto.randomUUID();
    pendingStreams.set(token, stream);
    pendingMeta.set(stream, {
      nodeId,
      auth,
      cid: cid || undefined,
      link,
      transport: this.deps.peers.transportOf?.(nodeId) ?? null,
    });
    const ok = server.upgrade(req, {
      data: { kind: MESH_FORWARD_WS_KIND, nodeId, auth, token, cid: cid || undefined },
    });
    if (!ok) {
      pendingStreams.delete(token);
      stream.close();
      return jsonError('upgrade_failed', 500);
    }
    return undefined;
  }

  private async adaptResponse(req: Request, upstream: Response, nodeId: string): Promise<Response> {
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

    const setSession = upstream.headers.get(X_TMEX_SET_SESSION);
    if (setSession) {
      const parsed = parseSetSessionHeader(setSession);
      if (parsed) appendNodeCookie(req, headers, nodeId, parsed.sid, parsed.maxAgeSec);
    }
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
    if (upstream.status !== 401) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    const raw = await readBodyLimited(upstream, AUTH_401_BODY_LIMIT);
    let body: Record<string, unknown> = { code: 'NODE_LOGIN_REQUIRED', nodeId };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = { ...(parsed as Record<string, unknown>), code: 'NODE_LOGIN_REQUIRED', nodeId };
      }
    } catch {
      if (raw) body.message = raw;
    }
    for (const name of DROP_ON_401_REWRITE) headers.delete(name);
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: 401, headers });
  }
}

class StreamReplayState {
  hello: Uint8Array | null = null;
  helloForwarded = false;
  readonly devices = new Map<string, Uint8Array>();
  readonly connectedForwarded = new Set<string>();
  readonly paneSubs = new Map<string, Uint8Array>();
  readonly lastSelect = new Map<string, Uint8Array>();
  readonly agents = new Map<string, Uint8Array>();
  canonicalSub: {
    generation: bigint;
    activePanes: wsBorsh.CanonicalPaneSubscription[];
    hotPanes: wsBorsh.CanonicalPaneSubscription[];
    seq: number;
  } | null = null;
  readonly paneCursors = new Map<
    string,
    { paneEpoch: Uint8Array; terminalSeq: bigint; pane: wsBorsh.CanonicalPaneTarget }
  >();
  private outboundSeq = 1;
  private readonly resumeDevices = new Set<string>();
  private resumeSnapshot = false;
  private resumeGeneration: bigint | null = null;

  noteOutbound(bytes: Uint8Array): void {
    let env: ReturnType<typeof wsBorsh.decodeEnvelope>;
    try {
      env = wsBorsh.decodeEnvelope(bytes);
    } catch {
      return;
    }
    this.outboundSeq = env.seq;
    try {
      switch (env.kind) {
        case wsBorsh.KIND_HELLO_C2S:
          this.hello = bytes.slice();
          return;
        case wsBorsh.KIND_DEVICE_CONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, env.payload);
          this.devices.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_DEVICE_DISCONNECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, env.payload);
          this.devices.delete(payload.deviceId);
          this.paneSubs.delete(payload.deviceId);
          this.lastSelect.delete(payload.deviceId);
          this.connectedForwarded.delete(payload.deviceId);
          return;
        }
        case wsBorsh.KIND_TMUX_SUBSCRIBE_PANES: {
          const payload = wsBorsh.decodePayload(
            wsBorsh.schema.TmuxSubscribePanesSchema,
            env.payload
          );
          if (payload.paneIds.length === 0) this.paneSubs.delete(payload.deviceId);
          else this.paneSubs.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_TMUX_SELECT: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, env.payload);
          this.lastSelect.set(payload.deviceId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_AGENT_SUBSCRIBE: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.AgentSubscribeSchema, env.payload);
          this.agents.set(payload.sessionId, bytes.slice());
          return;
        }
        case wsBorsh.KIND_AGENT_UNSUBSCRIBE: {
          const payload = wsBorsh.decodePayload(wsBorsh.schema.AgentUnsubscribeSchema, env.payload);
          this.agents.delete(payload.sessionId);
          return;
        }
        case wsBorsh.KIND_CANONICAL_COMMAND: {
          const command = wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
          if ('SetPaneSubscriptions' in command) {
            const value = command.SetPaneSubscriptions;
            this.canonicalSub = {
              generation: value.generation,
              activePanes: value.activePanes,
              hotPanes: value.hotPanes,
              seq: env.seq,
            };
          }
        }
      }
    } catch {
      // ignore undecodable tracking frames
    }
  }

  noteInbound(bytes: Uint8Array): void {
    let env: ReturnType<typeof wsBorsh.decodeEnvelope>;
    try {
      env = wsBorsh.decodeEnvelope(bytes);
    } catch {
      return;
    }
    if (env.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      const deviceId = this.noteDeviceConnected(bytes);
      if (deviceId) this.resumeDevices.add(deviceId);
      return;
    }
    if (env.kind === wsBorsh.KIND_STATE_SNAPSHOT || env.kind === wsBorsh.KIND_CHUNK) {
      if (this.resumeDevices.size > 0) this.resumeSnapshot = true;
      return;
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return;
    try {
      const event = wsBorsh.decodeCanonicalEventPayload(env.payload).event;
      if (!('PaneData' in event)) return;
      const paneData = event.PaneData;
      this.paneCursors.set(paneCursorKey(paneData.pane.deviceId, paneData.pane.paneId), {
        pane: paneData.pane,
        paneEpoch: paneData.paneEpoch,
        terminalSeq: paneData.seqEnd,
      });
    } catch {
      // ignore
    }
  }

  noteDeviceConnected(bytes: Uint8Array): string | null {
    try {
      const env = wsBorsh.decodeEnvelope(bytes);
      const payload = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, env.payload);
      return payload.deviceId;
    } catch {
      return null;
    }
  }

  beginResume(): void {
    this.resumeDevices.clear();
    this.resumeSnapshot = false;
    this.resumeGeneration = null;
  }

  isResumeReady(): boolean {
    for (const deviceId of this.devices.keys()) {
      if (!this.resumeDevices.has(deviceId)) return false;
    }
    if (this.devices.size > 0 && this.paneSubs.size > 0 && !this.resumeSnapshot) return false;
    return true;
  }

  buildConnectFrames(): Uint8Array[] {
    return [...this.devices.values()];
  }

  buildPostConnectFrames(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const canonical = this.buildCanonicalResume();
    if (canonical) frames.push(canonical);
    for (const frame of this.paneSubs.values()) frames.push(frame);
    for (const frame of this.lastSelect.values()) frames.push(frame);
    for (const frame of this.buildLegacyHistoryRequests()) frames.push(frame);
    for (const frame of this.agents.values()) frames.push(frame);
    return frames;
  }

  markCanonicalResumeSent(): void {
    if (!this.canonicalSub) return;
    const sent = this.canonicalSub.generation + 1n;
    this.canonicalSub = { ...this.canonicalSub, generation: sent };
    this.resumeGeneration = sent;
  }

  rewriteQueuedFrame(bytes: Uint8Array): Uint8Array | null {
    let env: ReturnType<typeof wsBorsh.decodeEnvelope>;
    try {
      env = wsBorsh.decodeEnvelope(bytes);
    } catch {
      return bytes;
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return bytes;
    try {
      const command = wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
      if (!('SetPaneSubscriptions' in command)) return bytes;
      const value = command.SetPaneSubscriptions;
      const floor = this.resumeGeneration ?? 0n;
      const generation = value.generation > floor ? value.generation : floor + 1n;
      this.canonicalSub = {
        generation,
        activePanes: value.activePanes,
        hotPanes: value.hotPanes,
        seq: env.seq,
      };
      this.resumeGeneration = generation;
      return wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation,
            activePanes: value.activePanes,
            hotPanes: value.hotPanes,
          },
        }),
        env.seq
      );
    } catch {
      return bytes;
    }
  }

  describeReplay(): { mode: string; panes: string; cursor: string } {
    if (this.canonicalSub) {
      const rows = [...this.canonicalSub.activePanes, ...this.canonicalSub.hotPanes];
      const panes = rows.map((row) => row.pane.paneId);
      const cursorParts = rows.map((row) => {
        const cursor = this.paneCursors.get(paneCursorKey(row.pane.deviceId, row.pane.paneId));
        return cursor ? `${row.pane.paneId}:${cursor.terminalSeq}` : `${row.pane.paneId}:-`;
      });
      return {
        mode: 'canonical',
        panes: panes.join(',') || '-',
        cursor: cursorParts.join(',') || '-',
      };
    }
    const paneIds: string[] = [];
    for (const frame of this.paneSubs.values()) {
      try {
        const env = wsBorsh.decodeEnvelope(frame);
        const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, env.payload);
        paneIds.push(...payload.paneIds);
      } catch {
        // ignore
      }
    }
    return {
      mode: paneIds.length > 0 ? 'legacy' : 'none',
      panes: paneIds.join(',') || '-',
      cursor: '-',
    };
  }

  resumedPaneCount(): number {
    if (this.canonicalSub) {
      const keys = new Set<string>();
      for (const row of this.canonicalSub.activePanes) {
        keys.add(paneCursorKey(row.pane.deviceId, row.pane.paneId));
      }
      for (const row of this.canonicalSub.hotPanes) {
        keys.add(paneCursorKey(row.pane.deviceId, row.pane.paneId));
      }
      return keys.size;
    }
    let count = 0;
    for (const frame of this.paneSubs.values()) {
      try {
        const env = wsBorsh.decodeEnvelope(frame);
        const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, env.payload);
        count += payload.paneIds.length;
      } catch {
        count += 1;
      }
    }
    return count;
  }

  private buildLegacyHistoryRequests(): Uint8Array[] {
    if (this.canonicalSub) return [];
    const frames: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const frame of this.paneSubs.values()) {
      try {
        const env = wsBorsh.decodeEnvelope(frame);
        const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, env.payload);
        for (const paneId of payload.paneIds) {
          const key = `${payload.deviceId}\0${paneId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const requestToken = new Uint8Array(16);
          crypto.getRandomValues(requestToken);
          this.outboundSeq += 1;
          frames.push(
            wsBorsh.encodeEnvelope(
              wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY,
              wsBorsh.encodePayload(wsBorsh.schema.TmuxFetchPaneHistorySchema, {
                deviceId: payload.deviceId,
                paneId,
                requestToken,
              }),
              this.outboundSeq
            )
          );
        }
      } catch {
        // ignore
      }
    }
    return frames;
  }

  private buildCanonicalResume(): Uint8Array | null {
    if (!this.canonicalSub) return null;
    const patch = (row: wsBorsh.CanonicalPaneSubscription): wsBorsh.CanonicalPaneSubscription => {
      const cursor = this.paneCursors.get(paneCursorKey(row.pane.deviceId, row.pane.paneId));
      if (!cursor) return row;
      return {
        pane: row.pane,
        cursor: { paneEpoch: cursor.paneEpoch, terminalSeq: cursor.terminalSeq },
      };
    };
    const payload = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: this.canonicalSub.generation + 1n,
        activePanes: this.canonicalSub.activePanes.map(patch),
        hotPanes: this.canonicalSub.hotPanes.map(patch),
      },
    });
    return wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CANONICAL_COMMAND,
      payload,
      this.canonicalSub.seq || this.outboundSeq
    );
  }
}

const pendingStreams = new Map<string, OpenedWsStream>();

export function takePendingForwardStream(token: string | undefined): OpenedWsStream | undefined {
  if (!token) return undefined;
  const stream = pendingStreams.get(token);
  if (stream) pendingStreams.delete(token);
  return stream;
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
      lower === 'cookie' ||
      lower === 'authorization' ||
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'upgrade' ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-forwarded-')
    ) {
      return;
    }
    out[key] = value;
  });
  return out;
}

function stripQuery(path: string): string {
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

function baseMime(contentType: string): string {
  const trimmed = contentType.trim().toLowerCase();
  if (!trimmed) return '';
  const semi = trimmed.indexOf(';');
  return (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
}

async function readBodyLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - total;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total = limit;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

function paneCursorKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
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
