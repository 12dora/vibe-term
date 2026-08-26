import type { StateSnapshotPayload } from '@tmex/shared';

import { getDeviceById } from '../db';
import type { PaneInfo } from './capture-history';
import type { LifecycleEventEmitter, TmuxConnectionOptions } from './connection-types';
import type { AtomicPaneCapture } from './control-mode-capture';
import type { TmuxEvent } from './events';
import { LocalExternalTmuxConnection } from './local-external-connection';
import {
  MetadataProjection,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
} from './metadata-projection';
import {
  type PaneHistoryCaptureInfo,
  type PaneHistoryCursor,
  type PaneHistoryPage,
  PaneHistoryReader,
} from './pane-history-reader';
import {
  type PaneIdentity,
  type PaneReplayPlan,
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
  type PaneRetentionConsumerLease,
  type PaneRetentionLimits,
  type PaneRetentionStats,
  type PaneScreenCheckpoint,
  type PaneTerminalCursor,
} from './pane-retention';
import type { PromptMarker } from './pane-stream-parser';
import { CanonicalScreenCapture } from './runtime/canonical-screen-capture';
import { RuntimeEventBridge } from './runtime/event-bridge';
import { SshExternalTmuxConnection } from './ssh-external-connection';

export interface DeviceSessionRuntimeConnection {
  connect(): Promise<void>;
  disconnect(): void;
  isSessionClosedEmitted?(): boolean;
  requestSnapshot(): void;
  sendInput(paneId: string, data: string): void;
  sendInputBytes?(paneId: string, data: Uint8Array): void;
  resizePane(paneId: string, cols: number, rows: number): void;
  selectPane(windowId: string, paneId: string): void;
  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void;
  selectWindow(windowId: string): void;
  updateDefaultWorkingDir(dir: string | undefined): void;
  createWindow(name?: string, cwd?: string): void;
  closeWindow(windowId: string): void;
  closePane(paneId: string): void;
  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void;
  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void;
  resizeWindow(windowId: string, cols: number, rows: number): void;
  selectLayout(windowId: string, preset: 'even-horizontal'): void;
  applyStackedLayout(windowId: string, cols: number, rows: number): void;
  focusPane(windowId: string, paneId: string): void;
  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void;
  breakPane(paneId: string): void;
  requestPaneHistory(paneId: string): Promise<void>;
  fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null>;
  renameWindow(windowId: string, name: string): void;
  setWindowStyle(style: string): Promise<void>;
  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  capturePaneFrameAtBarrier?(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture>;
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
  capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string>;
}

export interface DeviceSessionRuntimeListener {
  onEvent?: (event: TmuxEvent) => void;
  onTerminalOutput?: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory?: (
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onSnapshot?: (payload: StateSnapshotPayload) => void;
  onMetadataPatch?: (patch: MetadataProjectionPatch) => void;
  onMetadataRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface DeviceSessionRuntimeOptions {
  deviceId: string;
  deviceName?: string;
  notifyEvent?: LifecycleEventEmitter;
  createConnection?: (options: TmuxConnectionOptions) => DeviceSessionRuntimeConnection;
}

function createDefaultConnection(options: TmuxConnectionOptions): DeviceSessionRuntimeConnection {
  const device = getDeviceById(options.deviceId);
  if (device?.type === 'local') {
    return new LocalExternalTmuxConnection(options);
  }
  return new SshExternalTmuxConnection(options);
}

export class DeviceSessionRuntime {
  readonly deviceId: string;

  private readonly connection: DeviceSessionRuntimeConnection;
  private readonly metadataProjection: MetadataProjection;
  private readonly paneRetention = new PaneRetention();
  private readonly paneHistoryReader: PaneHistoryReader;
  private readonly listeners = new Set<DeviceSessionRuntimeListener>();
  private readonly eventBridge: RuntimeEventBridge;
  private readonly screenCapture: CanonicalScreenCapture;
  private lastSnapshot: StateSnapshotPayload | null = null;
  private connectPromise: Promise<void> | null = null;
  private terminated = false;
  private closeEmitted = false;
  private manualDisconnect = false;

  constructor(options: DeviceSessionRuntimeOptions) {
    this.deviceId = options.deviceId;
    const createConnection = options.createConnection ?? createDefaultConnection;
    const runtime = this;

    this.eventBridge = new RuntimeEventBridge({
      get metadata() {
        return runtime.metadataProjection;
      },
      get paneRetention() {
        return runtime.paneRetention;
      },
      getHistoryReader: () => runtime.paneHistoryReader,
      getLastSnapshot: () => runtime.lastSnapshot,
      setLastSnapshot: (payload) => {
        runtime.lastSnapshot = payload;
      },
      broadcast: (action) => runtime.broadcast(action),
      handleUnexpectedClose: () => runtime.handleUnexpectedClose(),
    });

    this.metadataProjection = new MetadataProjection(this.deviceId, {
      deviceName: options.deviceName,
      ...this.eventBridge.metadataCallbacks(),
    });

    this.connection = createConnection(
      this.eventBridge.connectionOptions({
        deviceId: this.deviceId,
        notifyEvent: options.notifyEvent,
      })
    );
    this.paneHistoryReader = new PaneHistoryReader(this.connection);
    this.screenCapture = new CanonicalScreenCapture({
      getPaneIdentity: (paneId) => this.getPaneIdentity(paneId),
      maxCheckpointBytesPerPane: () => this.paneRetention.maxCheckpointBytesPerPane,
      findProjectedPane: (paneId) =>
        this.lastSnapshot?.session?.windows
          .flatMap((window) => window.panes)
          .find((pane) => pane.id === paneId),
      getLatestCursor: (paneId) => this.paneRetention.getLatestCursor(paneId),
      get capturePaneFrameAtBarrier() {
        const capture = runtime.connection.capturePaneFrameAtBarrier;
        return capture ? capture.bind(runtime.connection) : undefined;
      },
      getPaneInfo: (paneId) => this.connection.getPaneInfo(paneId),
      capturePaneText: (paneId, opts) => this.connection.capturePaneText(paneId, opts),
      getPaneHistoryCaptureInfo: (paneId) => this.connection.getPaneHistoryCaptureInfo(paneId),
      createHistoryCursor: (paneId, paneEpoch, beforeLine) =>
        this.paneHistoryReader.createCursor(paneId, paneEpoch, beforeLine),
      storeScreenCheckpoint: (checkpoint) => this.paneRetention.storeScreenCheckpoint(checkpoint),
    });
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  // 本次连接是否已因 session gone 发出 session_closed（供断开告警抑制双发）。
  get sessionClosedEmitted(): boolean {
    return this.connection.isSessionClosedEmitted?.() ?? false;
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.terminated) {
      return Promise.reject(
        new Error(`Device session runtime already terminated: ${this.deviceId}`)
      );
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connection.connect().catch((error) => {
      this.terminated = true;
      this.connectPromise = null;
      this.metadataProjection.dispose();
      this.paneRetention.dispose();
      this.paneHistoryReader.dispose();
      throw error;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.manualDisconnect = true;
    this.connectPromise = null;
    this.connection.disconnect();
    this.metadataProjection.dispose();
    this.paneRetention.dispose();
    this.paneHistoryReader.dispose();
  }

  async shutdown(): Promise<void> {
    this.disconnect();
  }

  requestSnapshot(): void {
    this.connection.requestSnapshot();
  }

  getCurrentSnapshot(): StateSnapshotPayload | null {
    return this.lastSnapshot;
  }

  getMetadataSnapshot(): MetadataProjectionSnapshot {
    return this.metadataProjection.currentSnapshot();
  }

  getServerEpoch(): Uint8Array | null {
    return this.metadataProjection.serverEpoch;
  }

  getPaneIdentity(paneId: string): PaneIdentity | null {
    if (!this.metadataProjection.hasPane(paneId)) return null;
    const paneEpoch = this.metadataProjection.getPaneEpoch(paneId);
    return paneEpoch ? { paneId, paneEpoch } : null;
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks): PaneRetentionConsumerLease {
    return this.paneRetention.attachConsumer(callbacks);
  }

  getPaneRetentionStats(): PaneRetentionStats {
    return this.paneRetention.snapshotStats();
  }

  getPaneRetentionLimits(): PaneRetentionLimits {
    return this.paneRetention.snapshotLimits();
  }

  isPaneTerminalRetained(paneId: string): boolean {
    return this.paneRetention.isPaneRetained(paneId);
  }

  getPaneScreenCheckpoint(paneId: string): PaneScreenCheckpoint | null {
    return this.paneRetention.getScreenCheckpoint(paneId);
  }

  readPaneReplay(paneId: string, cursor: PaneTerminalCursor): PaneReplayPlan | null {
    return this.paneRetention.readReplay(paneId, cursor);
  }

  readPaneHistory(
    paneId: string,
    beforeCursor: PaneHistoryCursor | null,
    byteLimit: number
  ): Promise<PaneHistoryPage | null> {
    const identity = this.getPaneIdentity(paneId);
    if (!identity) return Promise.resolve(null);
    return this.paneHistoryReader.readPage(paneId, identity.paneEpoch, beforeCursor, byteLimit);
  }

  async captureCanonicalScreen(
    paneId: string,
    byteLimit: number
  ): Promise<PaneScreenCheckpoint | null> {
    return this.screenCapture.capture(paneId, byteLimit);
  }

  setCustomName(kind: 'window' | 'pane', nativeId: string, name: string | null): void {
    this.metadataProjection.setCustomName(kind, nativeId, name);
  }

  sendInput(paneId: string, data: string): void {
    this.connection.sendInput(paneId, data);
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    if (this.connection.sendInputBytes) {
      this.connection.sendInputBytes(paneId, data);
      return;
    }
    this.connection.sendInput(paneId, new TextDecoder().decode(data));
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    this.connection.resizePane(paneId, cols, rows);
  }

  selectPane(windowId: string, paneId: string): void {
    this.connection.selectPane(windowId, paneId);
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    this.connection.selectPaneWithSize(windowId, paneId, cols, rows);
  }

  selectWindow(windowId: string): void {
    this.connection.selectWindow(windowId);
  }

  updateDefaultWorkingDir(dir: string | undefined): void {
    this.connection.updateDefaultWorkingDir(dir);
  }

  createWindow(name?: string, cwd?: string): void {
    this.connection.createWindow(name, cwd);
  }

  closeWindow(windowId: string): void {
    this.connection.closeWindow(windowId);
  }

  closePane(paneId: string): void {
    this.connection.closePane(paneId);
  }

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    this.connection.splitPane(paneId, direction, cwd);
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    this.connection.resizePaneById(paneId, size);
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    this.connection.resizeWindow(windowId, cols, rows);
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    this.connection.selectLayout(windowId, preset);
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    this.connection.applyStackedLayout(windowId, cols, rows);
  }

  focusPane(windowId: string, paneId: string): void {
    this.connection.focusPane(windowId, paneId);
  }

  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    this.connection.movePane(srcPaneId, dstPaneId, position);
  }

  breakPane(paneId: string): void {
    this.connection.breakPane(paneId);
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    return this.connection.requestPaneHistory(paneId);
  }

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    return this.connection.fetchPaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.connection.renameWindow(windowId, name);
  }

  setWindowStyle(style: string): Promise<void> {
    return this.connection.setWindowStyle(style);
  }

  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    this.connection.signalThemeChange(paneId, theme);
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    return this.connection.capturePaneText(paneId, opts);
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    return this.connection.getPaneInfo(paneId);
  }

  private handleUnexpectedClose(): void {
    if (this.manualDisconnect || this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.terminated = true;
    this.connectPromise = null;
    this.broadcast((listener) => listener.onClose?.());
  }

  private broadcast(action: (listener: DeviceSessionRuntimeListener) => void): void {
    for (const listener of this.listeners) {
      try {
        action(listener);
      } catch (error) {
        console.error('[tmux-client] listener callback failed:', error);
      }
    }
  }
}

export function createDeviceSessionRuntime(
  options: DeviceSessionRuntimeOptions
): DeviceSessionRuntime {
  return new DeviceSessionRuntime(options);
}
