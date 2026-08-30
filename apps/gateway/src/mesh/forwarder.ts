import { wsBorsh } from '@tmex/shared';
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
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_FAILOVER_MAX_ATTEMPTS,
  STREAM_FAILOVER_RESUME_WAIT_MS,
  type StreamOpener,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  parseSetSessionHeader,
  setMeshRequestContext,
} from './mesh-deps';
import { isHttps, jsonError } from './session-middleware';

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
      pump.queue.push(bytes.slice());
      return;
    }
    pump.stream.send(bytes);
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
    const kind = pump.replay.noteInbound(bytes);
    if (pump.resumeWait && pump.replay.isResumeReady()) {
      pump.resumeWait();
      pump.resumeWait = null;
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
    if (hello) await wait('helloWait', 2_000, () => stream.send(hello));
    const sendAll = (frames: Uint8Array[]): void => {
      for (const frame of frames) {
        if (pumpDead(pump, signal)) return;
        stream.send(frame);
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
    } catch {}
  }

  noteInbound(bytes: Uint8Array): number | null {
    let env: ReturnType<typeof wsBorsh.decodeEnvelope>;
    try {
      env = wsBorsh.decodeEnvelope(bytes);
    } catch {
      return null;
    }
    if (env.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
      const deviceId = this.noteDeviceConnected(bytes);
      if (deviceId) this.resumeDevices.add(deviceId);
      return env.kind;
    }
    if (env.kind === wsBorsh.KIND_STATE_SNAPSHOT || env.kind === wsBorsh.KIND_CHUNK) {
      if (this.resumeDevices.size > 0) this.resumeSnapshot = true;
      return env.kind;
    }
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return env.kind;
    try {
      const header = wsBorsh.peekCanonicalPaneDataHeader(env.payload);
      if (header) {
        this.paneCursors.set(paneCursorKey(header.pane.deviceId, header.pane.paneId), {
          pane: header.pane,
          paneEpoch: header.paneEpoch,
          terminalSeq: header.seqEnd,
        });
        return env.kind;
      }
      wsBorsh.decodeCanonicalEventPayload(env.payload);
    } catch {}
    return env.kind;
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
    const canonical = this.buildCanonicalResume();
    return [
      ...(canonical ? [canonical] : []),
      ...this.paneSubs.values(),
      ...this.lastSelect.values(),
      ...this.buildLegacyHistoryRequests(),
      ...this.agents.values(),
    ];
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
    const rows = this.canonicalRows();
    if (rows) {
      return {
        mode: 'canonical',
        panes: rows.map((row) => row.pane.paneId).join(',') || '-',
        cursor:
          rows
            .map((row) => {
              const cursor = this.paneCursors.get(
                paneCursorKey(row.pane.deviceId, row.pane.paneId)
              );
              return `${row.pane.paneId}:${cursor ? cursor.terminalSeq : '-'}`;
            })
            .join(',') || '-',
      };
    }
    const paneIds = this.paneSubPayloads().flatMap((row) => row?.paneIds ?? []);
    return {
      mode: paneIds.length > 0 ? 'legacy' : 'none',
      panes: paneIds.join(',') || '-',
      cursor: '-',
    };
  }

  resumedPaneCount(): number {
    const rows = this.canonicalRows();
    if (rows) {
      return new Set(rows.map((row) => paneCursorKey(row.pane.deviceId, row.pane.paneId))).size;
    }
    let count = 0;
    for (const row of this.paneSubPayloads()) count += row ? row.paneIds.length : 1;
    return count;
  }

  private canonicalRows(): wsBorsh.CanonicalPaneSubscription[] | null {
    return this.canonicalSub
      ? [...this.canonicalSub.activePanes, ...this.canonicalSub.hotPanes]
      : null;
  }

  private paneSubPayloads(): Array<{ deviceId: string; paneIds: string[] } | null> {
    const out: Array<{ deviceId: string; paneIds: string[] } | null> = [];
    for (const frame of this.paneSubs.values()) {
      try {
        const env = wsBorsh.decodeEnvelope(frame);
        out.push(wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, env.payload));
      } catch {
        out.push(null);
      }
    }
    return out;
  }

  private buildLegacyHistoryRequests(): Uint8Array[] {
    if (this.canonicalSub) return [];
    const frames: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const row of this.paneSubPayloads()) {
      if (!row) continue;
      for (const paneId of row.paneIds) {
        const key = `${row.deviceId}\0${paneId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const requestToken = new Uint8Array(16);
        crypto.getRandomValues(requestToken);
        this.outboundSeq += 1;
        frames.push(
          wsBorsh.encodeEnvelope(
            wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY,
            wsBorsh.encodePayload(wsBorsh.schema.TmuxFetchPaneHistorySchema, {
              deviceId: row.deviceId,
              paneId,
              requestToken,
            }),
            this.outboundSeq
          )
        );
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
const pendingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_FORWARD_STREAM_TTL_MS = 15_000;

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
  }, PENDING_FORWARD_STREAM_TTL_MS);
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
