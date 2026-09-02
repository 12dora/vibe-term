import type {
  EventDevicePayload,
  EventType,
  StateSnapshotPayload,
  ThemeMode,
  WebhookEvent,
} from '@tmex/shared';
import { GATEWAY_CAPABILITIES, wsBorsh } from '@tmex/shared';
import type { Server, ServerWebSocket } from 'bun';
import { agentWsHub } from '../agent/ws-hub';
import type { DeviceTreeOrderRecord } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import { getDisplayVersion } from '../system/version';
import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../tmux-client/device-session-runtime';
import type { TmuxEvent } from '../tmux-client/events';
import {
  type BorshDispatchHost,
  type BorshKindHandlerMap,
  createBorshKindHandlers,
  dispatchBorshKind,
} from './borsh-dispatcher';
import { encodeCanonicalEvent, encodePayloadFrames, sendToClient } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { CanonicalFeedSession } from './canonical-feed-session';
import type { Carrier } from './carrier';
import { BunSocketCarrier } from './carrier';
import {
  DeviceConnectionRegistry,
  type DeviceConnectionRegistryHost,
} from './device-connection-registry';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import {
  type GatewayMetricsHost,
  logTerminalOutputMetricsIfDue,
  recordPingProbe,
} from './gateway-metrics-log';
import { GatewaySession } from './gateway-session';
import { LegacyFeedBroadcaster, type LegacyFeedHost } from './legacy-feed-broadcaster';
import { closeGatewaySession } from './session-close';
import { type SnapshotOverlayHost, SnapshotOverlayStore } from './snapshot-overlays';
import { TerminalOutputBatcher } from './terminal-output-batcher';
import { TerminalOutputMetrics } from './terminal-output-metrics';
import { ThemeSettingsBroadcaster, type ThemeSettingsHost } from './theme-settings-broadcaster';
import type { TmuxCommandHost } from './tmux-command-handlers';
import * as tmuxCommands from './tmux-command-handlers';
import {
  type DeviceConnectionEntry,
  type GatewaySocketData,
  type WebSocketServerDeps,
  type WebSocketServerOptions,
  defaultDeps,
} from './types';
import {
  GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES,
  gatewayWebSocketSendGuard,
} from './websocket-send-guard';

export { RUNTIME_IDLE_GRACE_MS } from './types';
export { parseWindowLayoutSize, payloadNeedsChunking } from './frame-utils';

function monotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class WebSocketServer
  implements
    BorshDispatchHost,
    DeviceConnectionRegistryHost,
    ThemeSettingsHost,
    SnapshotOverlayHost,
    LegacyFeedHost,
    TmuxCommandHost,
    GatewayMetricsHost
{
  readonly gatewayActivityMetrics = new GatewayActivityMetrics();
  readonly terminalOutputMetrics = new TerminalOutputMetrics();
  terminalOutputEventsUntilMetricsCheck = 1024;
  readonly terminalOutputBatcher = new TerminalOutputBatcher((deviceId, paneId, data) => {
    try {
      this.terminalOutputMetrics.recordBatch(data.length);
      this.feed.sendTerminalOutput(deviceId, paneId, data);
      this.reportTerminalOutputMetricsIfDue();
    } catch (error) {
      console.error('[ws] terminal output batch failed:', error);
    }
  });

  connectedClients = new Set<GatewaySession>();
  readonly canonicalSessions = new Map<GatewaySession, CanonicalFeedSession>();
  readonly deps: WebSocketServerDeps;
  private readonly registry: DeviceConnectionRegistry;
  private readonly theme: ThemeSettingsBroadcaster;
  private readonly overlays: SnapshotOverlayStore;
  private readonly feed: LegacyFeedBroadcaster;
  private readonly borshHandlers: BorshKindHandlerMap;

  get connections() {
    return this.registry.connections;
  }

  get pendingConnectionEntries() {
    return this.registry.pendingConnectionEntries;
  }

  get windowCustomNames() {
    return this.overlays.windowCustomNames;
  }

  get paneCustomNames() {
    return this.overlays.paneCustomNames;
  }

  get currentTheme(): ThemeMode | null {
    return this.theme.currentTheme;
  }

  set currentTheme(value: ThemeMode | null) {
    this.theme.currentTheme = value;
  }

  get lastBroadcastTheme() {
    return this.theme.lastBroadcastTheme;
  }

  get themeSignalLast() {
    return this.theme.themeSignalLast;
  }

  private carrierSwitchAckHandler:
    | ((session: GatewaySession, epoch: number, rtcSession: string) => void)
    | null = null;
  private sessionClosedHandler: ((session: GatewaySession) => void) | null = null;

  constructor(options: WebSocketServerOptions = {}) {
    this.deps = {
      ...defaultDeps,
      ...(options.deps ?? {}),
    };
    this.registry = new DeviceConnectionRegistry(this);
    this.theme = new ThemeSettingsBroadcaster(this);
    this.overlays = new SnapshotOverlayStore(this);
    this.feed = new LegacyFeedBroadcaster(this);
    this.borshHandlers = createBorshKindHandlers(this);
  }

  setOnCarrierSwitchAck(
    handler: ((session: GatewaySession, epoch: number, rtcSession: string) => void) | null
  ): void {
    this.carrierSwitchAckHandler = handler;
  }

  setOnSessionClosed(handler: ((session: GatewaySession) => void) | null): void {
    this.sessionClosedHandler = handler;
  }

  handleUpgrade(req: Request, server: Server<unknown>): Response | false | undefined {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return false;
    }

    const success = server.upgrade(req, {
      data: {} as GatewaySocketData,
    });

    return success ? undefined : new Response('Upgrade failed', { status: 500 });
  }

  private bindSocket(ws: ServerWebSocket<GatewaySocketData>): GatewaySession {
    if (ws.data?.session instanceof GatewaySession) {
      return ws.data.session;
    }
    const carrier = new BunSocketCarrier(ws);
    const session = new GatewaySession({ primary: carrier });
    carrier.logContext.sessionId = session.id;
    ws.data = { session, carrier };
    return session;
  }

  private bindingOf(ws: ServerWebSocket<GatewaySocketData> | GatewaySession): {
    session: GatewaySession;
    carrier: Carrier;
  } {
    if (ws instanceof GatewaySession) {
      return { session: ws, carrier: ws.activeCarrier };
    }
    return {
      session: ws.data.session,
      carrier: ws.data.carrier,
    };
  }

  handleOpen(ws: ServerWebSocket<GatewaySocketData> | GatewaySession): void {
    console.log('[ws] client connected');
    const session = ws instanceof GatewaySession ? ws : this.bindSocket(ws);
    session.onCarrierDetached = (carrier) => {
      gatewayWebSocketSendGuard.forget(carrier);
    };
    sessionStateStore.create(session);
    this.connectedClients.add(session);
  }

  attachStreamSession(carrier: Carrier): {
    session: GatewaySession;
    onMessage: (bytes: Uint8Array) => void;
    onDecodedEnvelope: (envelope: wsBorsh.Envelope) => void;
    onClose: () => void;
  } {
    const session = new GatewaySession({ primary: carrier });
    const ctx = carrier.logContext ?? { kind: 'physical_browser_ws' as const };
    carrier.logContext = { ...ctx, sessionId: session.id };
    this.handleOpen(session);
    carrier.onDrain(() => {
      this.handleDrain(session, carrier);
    });
    return {
      session,
      onMessage: (bytes) => {
        if (session.closed) return;
        this.handleMessage(session, Buffer.from(bytes));
      },
      onDecodedEnvelope: (envelope) => {
        if (session.closed) return;
        const p = envelope.payload;
        // 视图 payload 在 mux 缓冲回收后会失效；已独立持有则不必再拷
        const owned = p.byteOffset === 0 && p.byteLength === p.buffer.byteLength;
        this.handleDecodedEnvelope(session, owned ? envelope : { ...envelope, payload: p.slice() });
      },
      onClose: () => {
        this.handleCarrierClose(session, carrier);
      },
    };
  }

  handleMessage(
    ws: ServerWebSocket<GatewaySocketData> | GatewaySession,
    message: string | Buffer
  ): void {
    if (typeof message === 'string') return;
    this.deliverRtcInbound(this.bindingOf(ws).session, message);
  }

  deliverRtcInbound(session: GatewaySession, bytes: Uint8Array): void {
    if (session.closed) return;
    try {
      if (!wsBorsh.checkMagic(bytes)) {
        this.sendError(session, null, wsBorsh.ERROR_INVALID_FRAME, 'Missing magic bytes', false);
        return;
      }
      let envelope: wsBorsh.Envelope;
      try {
        envelope = wsBorsh.decodeEnvelope(bytes);
      } catch (err) {
        const e = err instanceof wsBorsh.WsBorshError ? err : null;
        this.sendError(
          session,
          null,
          e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
          e?.message ?? 'Invalid envelope',
          e?.retryable ?? false
        );
        return;
      }
      const p = envelope.payload;
      // 入站缓冲可能被回收；owned 启发式会把整块 ArrayBuffer 视图当成已持有，须再排除仍指向入站缓冲的情况。
      const owned =
        p.buffer !== bytes.buffer && p.byteOffset === 0 && p.byteLength === p.buffer.byteLength;
      this.handleDecodedEnvelope(session, owned ? envelope : { ...envelope, payload: p.slice() });
    } catch {}
  }

  handleDecodedEnvelope(session: GatewaySession, envelope: wsBorsh.Envelope): void {
    if (session.closed) {
      return;
    }

    if (envelope.kind === wsBorsh.KIND_CHUNK) {
      try {
        const chunk = wsBorsh.decodeChunk(envelope.payload);
        const reassembled = session.borshState.chunkReassembler.addChunk(chunk);
        if (!reassembled) {
          return;
        }
        void this.handleBorshMessage(
          session,
          reassembled.kind,
          reassembled.seq,
          reassembled.payload
        );
        return;
      } catch (err) {
        const e = err instanceof wsBorsh.WsBorshError ? err : null;
        this.sendError(
          session,
          null,
          e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
          e?.message ?? 'Invalid chunk',
          e?.retryable ?? false
        );
        return;
      }
    }

    void this.handleBorshMessage(session, envelope.kind, envelope.seq, envelope.payload);
  }

  handleDrain(ws: ServerWebSocket<GatewaySocketData> | GatewaySession, carrier?: Carrier): void {
    const binding = this.bindingOf(ws);
    const session = binding.session;
    if (session.closed) {
      return;
    }
    const drained = carrier ?? binding.carrier;
    if (drained instanceof BunSocketCarrier) {
      drained.emitDrain();
    }
    gatewayWebSocketSendGuard.handleDrain(drained);
    if (!session.handleCarrierDrain(drained)) {
      return;
    }
    this.canonicalSessions.get(session)?.onDrain();
  }

  getOrCreateCanonicalSession(session: GatewaySession): CanonicalFeedSession {
    const existing = this.canonicalSessions.get(session);
    if (existing) return existing;
    const canonical = new CanonicalFeedSession({
      maxFrameBytes: session.borshState.maxFrameBytes,
      sendEvent: (event) => this.sendCanonicalEvent(session, event),
      resolveRuntime: async (deviceId) => {
        const entry = await this.getOrCreateConnectionEntry(deviceId, session);
        if (!entry) return null;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(session);
        this.registry.clearIdleReleaseTimer(entry);
        return entry.runtime;
      },
      initialDeviceIds: () =>
        Array.from(this.connections, ([deviceId, entry]) =>
          entry.clients.has(session) ? deviceId : null
        ).filter((deviceId): deviceId is string => deviceId !== null),
      onDeviceAttached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(session);
        this.registry.clearIdleReleaseTimer(entry);
      },
      onDeviceDetached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients?.delete(session);
        this.registry.scheduleConnectionEntryRelease(deviceId, entry);
      },
    });
    this.canonicalSessions.set(session, canonical);
    return canonical;
  }

  private sendCanonicalEvent(
    session: GatewaySession,
    event: wsBorsh.CanonicalEvent
  ): boolean | 'backpressured' {
    const terminalBytes = 'PaneData' in event ? event.PaneData.data.byteLength : null;
    try {
      const frame = encodeCanonicalEvent(
        event,
        session.borshState.seqGen(),
        session.borshState.maxFrameBytes
      );
      const status = gatewayWebSocketSendGuard.sendFramesStatus(
        session.activeCarrier,
        [frame as unknown as BufferSource],
        session.borshState.maxFrameBytes
      );
      if (terminalBytes !== null) {
        this.terminalOutputMetrics.recordCanonicalRecipient(terminalBytes, status === 'sent');
      }
      if (status === 'backpressured') return 'backpressured';
      return status === 'sent';
    } catch (error) {
      if (terminalBytes !== null) {
        this.terminalOutputMetrics.recordCanonicalRecipient(terminalBytes, false);
      }
      console.error('[ws] failed to encode canonical event:', error);
      return false;
    }
  }

  handleCarrierClose(
    session: GatewaySession,
    carrier: Carrier,
    code = 1006,
    reason = 'carrier closed'
  ): void {
    if (session.closed) {
      return;
    }
    if (carrier === session.primary) {
      this.closeSession(session, code, reason);
      return;
    }
    if (session.direct === carrier) {
      session.detachCarrier(carrier);
    }
  }

  handleClose(ws: ServerWebSocket<GatewaySocketData> | GatewaySession): void {
    const { session } = this.bindingOf(ws);
    this.closeSession(session, 1006, 'client disconnected');
  }

  closeSession(session: GatewaySession, code: number, reason: string): void {
    closeGatewaySession(
      {
        onSessionClosed: this.sessionClosedHandler,
        registry: this.registry,
        canonicalSessions: this.canonicalSessions,
        connectedClients: this.connectedClients,
        feed: this.feed,
        connections: this.connections,
        refreshSnapshotPolling: (deviceId) => this.refreshSnapshotPolling(deviceId),
        dropViewportClaims: (target) => this.dropViewportClaims(target),
      },
      session,
      code,
      reason
    );
  }

  updateDefaultWorkingDir(deviceId: string, dir: string | undefined): void {
    const entry = this.connections.get(deviceId);
    entry?.runtime.updateDefaultWorkingDir(dir);
  }

  getLastSnapshot(deviceId: string): StateSnapshotPayload | null {
    return this.connections.get(deviceId)?.lastSnapshot ?? null;
  }

  closeAll(): void {
    for (const session of this.canonicalSessions.values()) session.close();
    this.canonicalSessions.clear();
    this.registry.closeAll();
  }

  async handleBorshMessage(
    ws: GatewaySession,
    kind: number,
    refSeq: number,
    payload: Uint8Array
  ): Promise<void> {
    if (ws.closed) {
      return;
    }
    try {
      const state = ws.borshState;
      this.gatewayActivityMetrics.recordInbound(kind, payload.length);

      if (kind !== wsBorsh.KIND_HELLO_C2S && !state.negotiated) {
        this.sendError(ws, refSeq, wsBorsh.ERROR_INVALID_FRAME, 'HELLO required', false);
        return;
      }

      if (kind === wsBorsh.KIND_HELLO_C2S) {
        this.handleHello(ws, refSeq, payload);
        return;
      }

      if (kind === wsBorsh.KIND_PING) {
        this.handlePing(ws, refSeq, payload);
        return;
      }

      if (kind === wsBorsh.KIND_CARRIER_SWITCH_ACK) {
        const ack = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchAckSchema, payload);
        this.carrierSwitchAckHandler?.(ws, Number(ack.epoch), ack.rtcSession);
        return;
      }

      await dispatchBorshKind(this.borshHandlers, this, ws, kind, refSeq, payload);
    } catch (err) {
      if (err instanceof wsBorsh.WsBorshError) {
        this.sendError(ws, refSeq, err.code, err.message, err.retryable);
        return;
      }
      console.error('[ws] borsh handler failed:', err);
      this.sendError(
        ws,
        refSeq,
        wsBorsh.ERROR_INTERNAL_ERROR,
        wsBorsh.getErrorMessage(wsBorsh.ERROR_INTERNAL_ERROR),
        false
      );
    }
  }

  private handleHello(ws: GatewaySession, refSeq: number, payload: Uint8Array): void {
    let hello: wsBorsh.b.infer<typeof wsBorsh.schema.HelloC2SSchema>;
    try {
      hello = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, payload);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'HELLO payload decode failed',
        e?.retryable ?? false
      );
      return;
    }

    const serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
    const effectiveMaxFrameBytes = Math.min(hello.maxFrameBytes, serverMaxFrameBytes);

    ws.borshState.negotiated = true;
    ws.borshState.clientImpl = hello.clientImpl.slice(0, 64);
    ws.borshState.maxFrameBytes = effectiveMaxFrameBytes;
    agentWsHub.registerClient(ws);

    const helloS2C: wsBorsh.b.infer<typeof wsBorsh.schema.HelloS2CSchema> = {
      serverImpl: 'tmex-gateway',
      serverVersion: getDisplayVersion(),
      selectedVersion: wsBorsh.CURRENT_VERSION,
      maxFrameBytes: serverMaxFrameBytes,
      heartbeatIntervalMs: 15000,
      capabilities: [...GATEWAY_CAPABILITIES],
    };

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, helloS2C);
    this.sendEnvelope(ws, wsBorsh.KIND_HELLO_S2C, payloadBytes);
  }

  private handlePing(ws: GatewaySession, refSeq: number, payload: Uint8Array): void {
    const startedAt = monotonicMs();
    try {
      const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload);
      const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
        nonce: ping.nonce,
        timeMs: ping.timeMs,
      });
      this.sendPong(ws, pongPayload, startedAt);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'PING payload decode failed',
        e?.retryable ?? false
      );
    }
  }

  /** PONG 走优先发送：不进入终端输出的 drop/defer 队列。 */
  private sendPong(ws: GatewaySession, payload: Uint8Array, startedAt: number): void {
    if (ws.closed) return;
    const carrier = ws.activeCarrier;
    const state = ws.borshState;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_PONG,
      payload,
      state.seqGen,
      state.maxFrameBytes
    );
    let buffered = 0;
    try {
      buffered = Math.max(0, carrier.bufferedAmount());
    } catch {
      buffered = 0;
    }
    const bypassed =
      buffered < GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES &&
      !gatewayWebSocketSendGuard.isBackpressured(carrier);
    gatewayWebSocketSendGuard.sendPriorityFrames(carrier, frames as readonly BufferSource[]);
    recordPingProbe({
      serverHandleMs: monotonicMs() - startedAt,
      path: bypassed ? 'bypassed' : 'queued',
      bufferedBytes: buffered,
    });
  }

  sendEnvelope(ws: GatewaySession, kind: number, payload: Uint8Array): void {
    this.sendChunked(ws, kind, payload);
  }

  sendControl(
    ws: GatewaySession,
    kind: number,
    payload: Uint8Array
  ): 'sent' | 'queued-backpressure' | 'blocked' | 'closed' {
    if (ws.closed) return 'closed';
    const carrier = ws.activeCarrier;
    if (gatewayWebSocketSendGuard.isBackpressured(carrier)) {
      return 'blocked';
    }
    const state = ws.borshState;
    const frames = encodePayloadFrames(kind, payload, state.seqGen, state.maxFrameBytes);
    const status = gatewayWebSocketSendGuard.sendFramesStatus(
      carrier,
      frames as readonly BufferSource[],
      state.maxFrameBytes
    );
    if (status === 'sent') return 'sent';
    if (status === 'backpressured') return 'queued-backpressure';
    return 'closed';
  }

  sendChunked(ws: GatewaySession, kind: number, payload: Uint8Array): boolean {
    const carrier = ws.activeCarrier;
    if (!gatewayWebSocketSendGuard.canSend(carrier)) {
      return false;
    }
    const state = ws.borshState;
    return sendToClient(
      carrier,
      encodePayloadFrames(kind, payload, state.seqGen, state.maxFrameBytes),
      state.maxFrameBytes
    );
  }

  sendError(
    ws: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
      refSeq,
      code,
      message,
      retryable,
    });
    this.sendEnvelope(ws, wsBorsh.KIND_ERROR, payload);
  }

  async getOrCreateConnectionEntry(
    deviceId: string,
    ws: GatewaySession
  ): Promise<DeviceConnectionEntry | null> {
    return this.registry.getOrCreate(deviceId, ws);
  }

  async createDeviceConnectionEntry(
    deviceId: string,
    ws: GatewaySession
  ): Promise<DeviceConnectionEntry | null> {
    return this.registry.createEntry(deviceId, ws);
  }

  releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry): void {
    this.terminalOutputBatcher.discardDevice(deviceId);
    this.registry.clearSnapshotTimer(entry);
    this.registry.clearSnapshotPollTimer(entry);
    this.registry.clearReconnectTimer(entry);
    this.registry.clearIdleReleaseTimer(entry);
    entry.detachRuntime?.();
    entry.detachRuntime = null;
    this.theme.clearDevice(deviceId);
    this.overlays.deleteDeviceTreeOrder(deviceId);
    void this.deps.releaseRuntime(deviceId, entry.runtime);
  }

  attachRuntime(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    const listener: DeviceSessionRuntimeListener = {
      onEvent: (event) => {
        void this.feed.broadcastTmuxEvent(deviceId, event);
      },
      onTerminalOutput: (paneId, data) => {
        this.feed.broadcastTerminalOutput(deviceId, paneId, data);
      },
      onTerminalHistory: (paneId, data, alternateScreen, modes) => {
        this.feed.broadcastTerminalHistory(deviceId, paneId, data, alternateScreen, modes);
      },
      onClipboardWrite: (paneId, text) => {
        this.feed.broadcastClipboardWrite(deviceId, paneId, text);
      },
      onSnapshot: (payload) => {
        this.feed.broadcastStateSnapshot(deviceId, payload);
      },
      onMetadataPatch: (patch) => {
        this.feed.broadcastLegacyMetadataPatch(deviceId, patch, runtime.getCurrentSnapshot());
      },
      onMetadataRebaseRequired: () => {
        const snapshot = runtime.getCurrentSnapshot();
        if (snapshot) this.feed.broadcastStateSnapshot(deviceId, snapshot);
      },
      onError: (error) => {
        this.feed.broadcastError(deviceId, error);
      },
      onClose: () => {
        void this.registry.handleConnectionClose(deviceId);
      },
    };

    return runtime.subscribe(listener);
  }

  refreshSnapshotPolling(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    this.registry.clearSnapshotPollTimer(entry);
  }

  async handleDeviceConnect(ws: GatewaySession, deviceId: string): Promise<void> {
    await this.registry.handleDeviceConnect(ws, deviceId);
  }

  handleDeviceDisconnect(ws: GatewaySession, deviceId: string): void {
    this.registry.handleDeviceDisconnect(ws, deviceId);
  }

  syncLegacyPaneObservers(session: GatewaySession, deviceId: string): void {
    this.feed.syncLegacyPaneObservers(session, deviceId);
  }

  releaseLegacyPaneObservers(session: GatewaySession, deviceId?: string): void {
    this.feed.releaseLegacyPaneObservers(session, deviceId);
  }

  handleTmuxSelect(
    ws: GatewaySession,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void {
    tmuxCommands.handleTmuxSelect(this, ws, data);
  }

  handleTmuxSelectWindow(deviceId: string, windowId: string): void {
    tmuxCommands.handleTmuxSelectWindow(this, deviceId, windowId);
  }

  handleTermInput(deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermInput(this, deviceId, paneId, data);
  }

  handleTermResize(
    session: GatewaySession,
    deviceId: string,
    paneId: string,
    cols: number,
    rows: number
  ): void {
    tmuxCommands.handleTermResize(this, session, deviceId, paneId, cols, rows);
  }

  handleTermViewport(
    session: GatewaySession,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.TermViewportSchema>
  ): void {
    tmuxCommands.handleTermViewport(this, session, decoded);
  }

  dropViewportClaims(
    session: GatewaySession,
    deviceId?: string,
    options: { recompute?: boolean } = {}
  ): void {
    tmuxCommands.dropViewportClaims(this, session, deviceId, options);
  }

  handleTermPaste(deviceId: string, paneId: string, data: string): void {
    tmuxCommands.handleTermPaste(this, deviceId, paneId, data);
  }

  handleCreateWindow(deviceId: string, name?: string, cwd?: string): void {
    tmuxCommands.handleCreateWindow(this, deviceId, name, cwd);
  }

  handleCloseWindow(deviceId: string, windowId: string): void {
    tmuxCommands.handleCloseWindow(this, deviceId, windowId);
  }

  handleClosePane(deviceId: string, paneId: string): void {
    tmuxCommands.handleClosePane(this, deviceId, paneId);
  }

  renamePane(deviceId: string, paneId: string, name: string): void {
    tmuxCommands.renamePane(this, deviceId, paneId, name);
  }

  handleBreakPane(deviceId: string, paneId: string): void {
    tmuxCommands.handleBreakPane(this, deviceId, paneId);
  }

  handleMovePane(deviceId: string, srcPaneId: string, dstPaneId: string, position: number): void {
    tmuxCommands.handleMovePane(this, deviceId, srcPaneId, dstPaneId, position);
  }

  renameWindow(deviceId: string, windowId: string, name: string): void {
    tmuxCommands.renameWindow(this, deviceId, windowId, name);
  }

  getCustomNames(deviceId: string): {
    windows: Record<string, string>;
    panes: Record<string, string>;
  } {
    return tmuxCommands.getCustomNames(this, deviceId);
  }

  handleSetWindowStyle(deviceId: string, style: string): void {
    tmuxCommands.handleSetWindowStyle(this, deviceId, style);
  }

  handleSiteThemeUpdate(
    ws: GatewaySession,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void {
    this.theme.handleSiteThemeUpdate(ws, decoded);
  }

  scheduleTmuxThemeApply(theme: ThemeMode): void {
    this.theme.scheduleTmuxThemeApply(theme);
  }

  broadcastSiteThemeUpdateS2C(theme: ThemeMode): void {
    this.theme.broadcastSiteThemeUpdateS2C(theme);
  }

  broadcastSettingsUpdate(namespace: SettingsNamespace): void {
    this.theme.broadcastSettingsUpdate(namespace);
  }

  broadcastEventNotify(eventType: EventType, event: WebhookEvent): void {
    this.theme.broadcastEventNotify(eventType, event);
  }

  async handleSiteThemeChange(theme: ThemeMode): Promise<void> {
    await this.theme.handleSiteThemeChange(theme);
  }

  applyThemeToDevice(deviceId: string): void {
    this.theme.applyThemeToDevice(deviceId);
  }

  broadcastThemeChange(theme: 'dark' | 'light'): void {
    this.theme.broadcastThemeChange(theme);
  }

  reorderWindows(deviceId: string, windowIds: string[]): void {
    tmuxCommands.reorderWindows(this, deviceId, windowIds);
  }

  reorderPanes(deviceId: string, windowId: string, paneIds: string[]): void {
    tmuxCommands.reorderPanes(this, deviceId, windowId, paneIds);
  }

  handleSubscribePanes(ws: GatewaySession, deviceId: string, paneIds: string[]): void {
    tmuxCommands.handleSubscribePanes(this, ws, deviceId, paneIds);
  }

  handleFetchPaneHistory(
    ws: GatewaySession,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array,
    byteLimit?: number | null
  ): void {
    tmuxCommands.handleFetchPaneHistory(this, ws, deviceId, paneId, requestToken, byteLimit);
  }

  handleResizePaneById(deviceId: string, paneId: string, cols?: number, rows?: number): void {
    tmuxCommands.handleResizePaneById(this, deviceId, paneId, cols, rows);
  }

  handleApplyStackedLayout(deviceId: string, windowId: string, cols: number, rows: number): void {
    tmuxCommands.handleApplyStackedLayout(this, deviceId, windowId, cols, rows);
  }

  handleSplitPane(deviceId: string, paneId: string, direction: number, cwd?: string): void {
    tmuxCommands.handleSplitPane(this, deviceId, paneId, direction, cwd);
  }

  handleFocusPane(ws: GatewaySession, deviceId: string, windowId: string, paneId: string): void {
    tmuxCommands.handleFocusPane(this, ws, deviceId, windowId, paneId);
  }

  encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array {
    return this.overlays.encodeSnapshotWithOverlays(payload);
  }

  getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
    return this.overlays.getCachedDeviceTreeOrder(deviceId);
  }

  storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord {
    return this.overlays.storeDeviceTreeOrder(order);
  }

  sendSnapshotToClients(entry: DeviceConnectionEntry, payload: StateSnapshotPayload): void {
    this.feed.sendSnapshotToClients(entry, payload);
  }

  broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    this.feed.broadcastTerminalOutput(deviceId, paneId, data);
  }

  async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    await this.feed.broadcastTmuxEvent(deviceId, event);
  }

  async extendTmuxEvent(deviceId: string, event: TmuxEvent): Promise<TmuxEvent> {
    return this.feed.extendTmuxEvent(deviceId, event);
  }

  onStateSnapshotInstalled(deviceId: string): void {
    tmuxCommands.reconcileDeviceViewportSnapshot(this, deviceId);
  }

  broadcastStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    this.feed.broadcastStateSnapshot(deviceId, payload);
  }

  broadcastTerminalHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    this.feed.broadcastTerminalHistory(deviceId, paneId, data, alternateScreen, modes);
  }

  broadcastDeviceError(deviceId: string, payload: EventDevicePayload): void {
    this.feed.broadcastDeviceError(deviceId, payload);
  }

  broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    this.feed.broadcastDeviceEvent(entry, payload);
  }

  reportTerminalOutputMetricsIfDue(): void {
    logTerminalOutputMetricsIfDue(this);
  }
}
