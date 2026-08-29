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
import {
  createBorshClientState,
  encodeCanonicalEvent,
  encodePayloadFrames,
  sendToClient,
} from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { CanonicalFeedSession } from './canonical-feed-session';
import {
  DeviceConnectionRegistry,
  type DeviceConnectionRegistryHost,
} from './device-connection-registry';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import { type GatewayMetricsHost, logTerminalOutputMetricsIfDue } from './gateway-metrics-log';
import { decodeInboundFrame } from './inbound-frame-decoder';
import { LegacyFeedBroadcaster, type LegacyFeedHost } from './legacy-feed-broadcaster';
import { type SnapshotOverlayHost, SnapshotOverlayStore } from './snapshot-overlays';
import { TerminalOutputBatcher } from './terminal-output-batcher';
import { TerminalOutputMetrics } from './terminal-output-metrics';
import { ThemeSettingsBroadcaster, type ThemeSettingsHost } from './theme-settings-broadcaster';
import type { TmuxCommandHost } from './tmux-command-handlers';
import * as tmuxCommands from './tmux-command-handlers';
import {
  type ClientState,
  type DeviceConnectionEntry,
  type WebSocketServerDeps,
  type WebSocketServerOptions,
  defaultDeps,
} from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

export { RUNTIME_IDLE_GRACE_MS } from './types';
export { parseWindowLayoutSize, payloadNeedsChunking } from './frame-utils';

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

  connectedClients = new Set<ServerWebSocket<ClientState>>();
  readonly canonicalSessions = new Map<ServerWebSocket<ClientState>, CanonicalFeedSession>();
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

  handleUpgrade(req: Request, server: Server<unknown>): Response | false | undefined {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return false;
    }

    const success = server.upgrade(req, {
      data: {
        borshState: createBorshClientState(),
      } satisfies ClientState,
    });

    return success ? undefined : new Response('Upgrade failed', { status: 500 });
  }

  handleOpen(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client connected');
    sessionStateStore.create(ws);
    this.connectedClients.add(ws);
  }

  handleMessage(ws: ServerWebSocket<ClientState>, message: string | Buffer): void {
    if (typeof message === 'string') {
      return;
    }

    const decoded = decodeInboundFrame(
      new Uint8Array(message),
      ws.data.borshState.chunkReassembler
    );
    if (decoded.status === 'ignore') {
      return;
    }
    if (decoded.status === 'error') {
      this.sendError(ws, null, decoded.code, decoded.message, decoded.retryable);
      return;
    }
    void this.handleBorshMessage(ws, decoded.kind, decoded.seq, decoded.payload);
  }

  handleDrain(ws: ServerWebSocket<ClientState>): void {
    gatewayWebSocketSendGuard.handleDrain(ws as ServerWebSocket<unknown>);
    this.canonicalSessions.get(ws)?.onDrain();
  }

  getOrCreateCanonicalSession(ws: ServerWebSocket<ClientState>): CanonicalFeedSession {
    const existing = this.canonicalSessions.get(ws);
    if (existing) return existing;
    const session = new CanonicalFeedSession({
      maxFrameBytes: ws.data.borshState.maxFrameBytes,
      sendEvent: (event) => this.sendCanonicalEvent(ws, event),
      resolveRuntime: async (deviceId) => {
        const entry = await this.getOrCreateConnectionEntry(deviceId, ws);
        if (!entry) return null;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(ws);
        this.registry.clearIdleReleaseTimer(entry);
        return entry.runtime;
      },
      initialDeviceIds: () =>
        Array.from(this.connections, ([deviceId, entry]) =>
          entry.clients.has(ws) ? deviceId : null
        ).filter((deviceId): deviceId is string => deviceId !== null),
      onDeviceAttached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(ws);
        this.registry.clearIdleReleaseTimer(entry);
      },
      onDeviceDetached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients?.delete(ws);
        this.registry.scheduleConnectionEntryRelease(deviceId, entry);
      },
    });
    this.canonicalSessions.set(ws, session);
    return session;
  }

  private sendCanonicalEvent(
    ws: ServerWebSocket<ClientState>,
    event: wsBorsh.CanonicalEvent
  ): boolean | 'backpressured' {
    const terminalBytes = 'PaneData' in event ? event.PaneData.data.byteLength : null;
    try {
      const frame = encodeCanonicalEvent(
        event,
        ws.data.borshState.seqGen(),
        ws.data.borshState.maxFrameBytes
      );
      const status = gatewayWebSocketSendGuard.sendFramesStatus(ws as ServerWebSocket<unknown>, [
        frame as unknown as BufferSource,
      ]);
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

  handleClose(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client disconnected');

    this.canonicalSessions.get(ws)?.close();
    this.canonicalSessions.delete(ws);
    gatewayWebSocketSendGuard.forget(ws as ServerWebSocket<unknown>);
    this.connectedClients.delete(ws);
    switchBarrier.cleanupClient(ws);
    sessionStateStore.cleanup(ws);
    agentWsHub.removeClient(ws);

    for (const [deviceId, entry] of this.connections) {
      entry.canonicalClients?.delete(ws);
      if (entry.clients.delete(ws)) {
        delete ws.data.borshState.selectedPanes[deviceId];
        delete ws.data.borshState.subscribedPanes[deviceId];
      }
      this.refreshSnapshotPolling(deviceId);
      this.registry.scheduleConnectionEntryRelease(deviceId, entry);
    }
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
    ws: ServerWebSocket<ClientState>,
    kind: number,
    refSeq: number,
    payload: Uint8Array
  ): Promise<void> {
    try {
      const state = ws.data.borshState;
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

  private handleHello(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
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

    ws.data.borshState.negotiated = true;
    ws.data.borshState.clientImpl = hello.clientImpl.slice(0, 64);
    ws.data.borshState.maxFrameBytes = effectiveMaxFrameBytes;
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

  private handlePing(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    try {
      const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload);
      const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
        nonce: ping.nonce,
        timeMs: ping.timeMs,
      });
      this.sendEnvelope(ws, wsBorsh.KIND_PONG, pongPayload);
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

  sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void {
    this.sendChunked(ws, kind, payload);
  }

  sendChunked(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): boolean {
    if (!gatewayWebSocketSendGuard.canSend(ws as ServerWebSocket<unknown>)) {
      return false;
    }
    const state = ws.data.borshState;
    return sendToClient(
      ws as ServerWebSocket<unknown>,
      encodePayloadFrames(kind, payload, state.seqGen, state.maxFrameBytes)
    );
  }

  sendError(
    ws: ServerWebSocket<ClientState>,
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
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    return this.registry.getOrCreate(deviceId, ws);
  }

  async createDeviceConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
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

  async handleDeviceConnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void> {
    await this.registry.handleDeviceConnect(ws, deviceId);
  }

  handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): void {
    this.registry.handleDeviceDisconnect(ws, deviceId);
  }

  handleTmuxSelect(
    ws: ServerWebSocket<ClientState>,
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

  handleTermResize(deviceId: string, paneId: string, cols: number, rows: number): void {
    tmuxCommands.handleTermResize(this, deviceId, paneId, cols, rows);
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
    ws: ServerWebSocket<ClientState>,
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

  handleSubscribePanes(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneIds: string[]
  ): void {
    tmuxCommands.handleSubscribePanes(this, ws, deviceId, paneIds);
  }

  handleFetchPaneHistory(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array
  ): void {
    tmuxCommands.handleFetchPaneHistory(this, ws, deviceId, paneId, requestToken);
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

  handleFocusPane(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    windowId: string,
    paneId: string
  ): void {
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
