import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import {
  type BorshDispatchHost,
  type BorshKindHandlerMap,
  createBorshKindHandlers,
  dispatchBorshKind,
} from './borsh-dispatcher';
import { getOrCreateCanonicalSession } from './canonical-client';
import type { CanonicalFeedSession } from './canonical-feed-session';
import {
  type WebSocketUpgradeServer,
  closeAllClients,
  closeClient,
  handleClientDrain,
  handleUpgrade,
  openClient,
} from './client-lifecycle';
import { sendClientChunked, sendClientEnvelope, sendClientError } from './client-send';
import { WebSocketCommandFacade } from './command-facade';
import {
  DeviceConnectionRegistry,
  type DeviceConnectionRegistryHost,
} from './device-connection-registry';
import { GatewayActivityMetrics } from './gateway-activity-metrics';
import { type GatewayMetricsHost, logTerminalOutputMetricsIfDue } from './gateway-metrics-log';
import { handleHello, handlePing } from './hello-negotiation';
import { decodeInboundFrame } from './inbound-frame-decoder';
import { LegacyFeedBroadcaster, type LegacyFeedHost } from './legacy-feed-broadcaster';
import { attachRuntimeListener, releaseDeviceConnection } from './runtime-attachment';
import { type SnapshotOverlayHost, SnapshotOverlayStore } from './snapshot-overlays';
import { TerminalOutputBatcher } from './terminal-output-batcher';
import { TerminalOutputMetrics } from './terminal-output-metrics';
import { ThemeSettingsBroadcaster, type ThemeSettingsHost } from './theme-settings-broadcaster';
import type { TmuxCommandHost } from './tmux-command-handlers';
import {
  type ClientState,
  type DeviceConnectionEntry,
  type WebSocketServerDeps,
  type WebSocketServerOptions,
  defaultDeps,
} from './types';

export { RUNTIME_IDLE_GRACE_MS } from './types';
export { parseWindowLayoutSize, payloadNeedsChunking } from './frame-utils';

export class WebSocketServer
  extends WebSocketCommandFacade
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
  protected readonly registry: DeviceConnectionRegistry;
  protected readonly theme: ThemeSettingsBroadcaster;
  protected readonly overlays: SnapshotOverlayStore;
  protected readonly feed: LegacyFeedBroadcaster;
  private readonly borshHandlers: BorshKindHandlerMap;

  constructor(options: WebSocketServerOptions = {}) {
    super();
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

  handleUpgrade(req: Request, server: WebSocketUpgradeServer): Response | false | undefined {
    return handleUpgrade(req, server);
  }

  handleOpen(ws: ServerWebSocket<ClientState>): void {
    openClient(ws, this.connectedClients);
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
    handleClientDrain(ws, this.canonicalSessions);
  }

  getOrCreateCanonicalSession(ws: ServerWebSocket<ClientState>): CanonicalFeedSession {
    return getOrCreateCanonicalSession(this, this.registry, ws);
  }

  handleClose(ws: ServerWebSocket<ClientState>): void {
    closeClient(this, this.registry, ws);
  }

  closeAll(): void {
    closeAllClients(this.canonicalSessions, this.registry);
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
    handleHello(this, ws, refSeq, payload);
  }

  private handlePing(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    handlePing(this, ws, refSeq, payload);
  }

  sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void {
    sendClientEnvelope(ws, kind, payload);
  }

  sendChunked(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): boolean {
    return sendClientChunked(ws, kind, payload);
  }

  sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    sendClientError(ws, refSeq, code, message, retryable);
  }

  releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry): void {
    releaseDeviceConnection({
      terminalOutputBatcher: this.terminalOutputBatcher,
      registry: this.registry,
      theme: this.theme,
      overlays: this.overlays,
      deps: this.deps,
      deviceId,
      entry,
    });
  }

  attachRuntime(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    return attachRuntimeListener(this.feed, this.registry, deviceId, runtime);
  }

  reportTerminalOutputMetricsIfDue(): void {
    logTerminalOutputMetricsIfDue(this);
  }
}
