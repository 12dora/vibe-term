import type { Device, TmuxSession, TmuxWindow } from '@tmex/shared';

import { config } from '../config';
import { updateDeviceRuntimeStatus } from '../db';
import type { PaneInfo } from './capture-history';
import type { TmuxConnectionOptions } from './connection-types';
import { type AtomicPaneCapture, ControlModeCommandQueue } from './control-mode-capture';
import type {
  ControlModeSubscription,
  ControlModeSubscriptionCallbacks,
} from './control-mode-subscription';
import { ConnectionCleanup, type ConnectionCleanupHost } from './external/connection-cleanup';
import { BELL_DEDUP_WINDOW_MS } from './external/constants';
import { type ControlModeHost, ControlModeLifecycle } from './external/control-mode-lifecycle';
import { type SessionCommandHost, SessionCommands } from './external/session-commands';
import { SnapshotProjector, type SnapshotProjectorHost } from './external/snapshot-projector';
import {
  ThemeSubscriptionController,
  type ThemeSubscriptionHost,
} from './external/theme-subscription';
import type { CommandResult, ExternalControlHandle } from './external/types';
import { ConnectionLifecycleEmitter } from './lifecycle-emitter';
import type { PaneStreamNotification } from './pane-stream-parser';
import { ensureStableServerEpoch } from './server-epoch';
import { SnapshotRefreshCoordinator } from './snapshot-refresh-coordinator';

export type { CommandResult, ExternalControlHandle } from './external/types';
export {
  BELL_DEDUP_WINDOW_MS,
  CONTROL_ATTACH_READY_TIMEOUT_MS,
  CONTROL_MAX_RESTARTS,
  CONTROL_RESTART_DELAY_MS,
  CONTROL_STABLE_RESET_MS,
  CONTROL_STDERR_TAIL_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PARKING_WINDOW_NAME,
} from './external/constants';
export { hasRenderableTerminalContent, isTmuxServerGoneMessage } from './external/helpers';

export const BELL_DEDUP_PRUNE_EVERY_INSERTS = 32;

export interface BellDedupBook {
  entries: Map<string, number>;
  insertsSincePrune: number;
  lastPruneAt: number;
}

export function createBellDedupBook(): BellDedupBook {
  return { entries: new Map(), insertsSincePrune: 0, lastPruneAt: 0 };
}

export function pruneBellDedupEntries(
  entries: Map<string, number>,
  now: number,
  windowMs: number
): void {
  for (const [key, timestamp] of entries) {
    if (now - timestamp >= windowMs) {
      entries.delete(key);
    }
  }
}

export function noteBellDedup(
  book: BellDedupBook,
  key: string,
  now: number,
  windowMs: number = BELL_DEDUP_WINDOW_MS,
  pruneEveryInserts: number = BELL_DEDUP_PRUNE_EVERY_INSERTS
): boolean {
  const previous = book.entries.get(key) ?? 0;
  if (now - previous < windowMs) {
    return false;
  }

  book.entries.set(key, now);
  book.insertsSincePrune += 1;
  if (book.insertsSincePrune >= pruneEveryInserts || now - book.lastPruneAt >= windowMs) {
    pruneBellDedupEntries(book.entries, now, windowMs);
    book.insertsSincePrune = 0;
    book.lastPruneAt = now;
  }
  return true;
}

class ConnectAbandonedError extends Error {
  readonly name = 'ConnectAbandonedError';

  constructor() {
    super('tmux connect abandoned');
  }
}

type ExternalTmuxCollaboratorHost = SessionCommandHost &
  ControlModeHost &
  ThemeSubscriptionHost &
  SnapshotProjectorHost &
  ConnectionCleanupHost;

export abstract class ExternalTmuxConnectionCore {
  protected readonly deviceId: string;
  protected readonly callbacks: TmuxConnectionOptions;
  protected readonly lookupDevice: (deviceId: string) => Device | null;
  protected readonly lifecycle: ConnectionLifecycleEmitter;
  protected readonly snapshotRefreshCoordinator = new SnapshotRefreshCoordinator(() =>
    this.performSnapshot()
  );

  protected device: Device | null = null;
  protected sessionName = 'tmex';
  protected connected = false;
  protected manualDisconnect = false;
  protected closeNotified = false;
  protected cleanupPromise: Promise<void> | null = null;
  protected activeWindowId: string | null = null;
  protected activePaneId: string | null = null;
  protected snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  protected snapshotWindows = new Map<string, TmuxWindow>();
  private readonly bellDedupBook = createBellDedupBook();
  protected get bellDedup(): Map<string, number> {
    return this.bellDedupBook.entries;
  }
  protected controlSubscription: ControlModeSubscription | null = null;
  protected controlCommands = new ControlModeCommandQueue();
  protected controlStartedAt = 0;
  protected controlRestartCount = 0;
  protected controlStderrTail = '';
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected heartbeatPending = false;
  protected heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  protected connectGeneration = 0;

  private readonly sessionCommands: SessionCommands;
  private readonly controlLifecycle: ControlModeLifecycle;
  private readonly themeController: ThemeSubscriptionController;
  private readonly snapshotProjector: SnapshotProjector;
  private readonly connectionCleanup: ConnectionCleanup;

  protected abstract readonly logPrefix: string;
  protected abstract readonly stalledControlLabel: string;

  protected constructor(
    options: TmuxConnectionOptions,
    lookupDevice: (deviceId: string) => Device | null
  ) {
    this.deviceId = options.deviceId;
    this.callbacks = options;
    this.lookupDevice = lookupDevice;
    this.lifecycle = new ConnectionLifecycleEmitter({
      getDevice: () => this.device ?? this.lookupDevice(this.deviceId),
      getSessionName: () => this.sessionName,
      isEmittable: () => this.connected && !this.manualDisconnect,
      getSnapshotWindows: () => this.snapshotWindows,
      notifyEvent: options.notifyEvent,
    });
    const host = this.bindCollaboratorHost();
    this.sessionCommands = new SessionCommands(host);
    this.controlLifecycle = new ControlModeLifecycle(host);
    this.themeController = new ThemeSubscriptionController(host);
    this.snapshotProjector = new SnapshotProjector(host);
    this.connectionCleanup = new ConnectionCleanup(host);
  }

  private bindCollaboratorHost(): ExternalTmuxCollaboratorHost {
    const core = this;
    return {
      get deviceId() {
        return core.deviceId;
      },
      get sessionName() {
        return core.sessionName;
      },
      get connected() {
        return core.connected;
      },
      set connected(value) {
        core.connected = value;
      },
      get connectGeneration() {
        return core.connectGeneration;
      },
      get manualDisconnect() {
        return core.manualDisconnect;
      },
      get logPrefix() {
        return core.logPrefix;
      },
      get stalledControlLabel() {
        return core.stalledControlLabel;
      },
      get activeWindowId() {
        return core.activeWindowId;
      },
      set activeWindowId(value) {
        core.activeWindowId = value;
      },
      get activePaneId() {
        return core.activePaneId;
      },
      set activePaneId(value) {
        core.activePaneId = value;
      },
      get snapshotWindows() {
        return core.snapshotWindows;
      },
      get snapshotSession() {
        return core.snapshotSession;
      },
      set snapshotSession(value) {
        core.snapshotSession = value;
      },
      get callbacks() {
        return core.callbacks;
      },
      get controlCommands() {
        return core.controlCommands;
      },
      get controlStderrTail() {
        return core.controlStderrTail;
      },
      get controlSubscription() {
        return core.controlSubscription;
      },
      set controlSubscription(value) {
        core.controlSubscription = value;
      },
      get heartbeatTimer() {
        return core.heartbeatTimer;
      },
      set heartbeatTimer(value) {
        core.heartbeatTimer = value;
      },
      get heartbeatPending() {
        return core.heartbeatPending;
      },
      set heartbeatPending(value) {
        core.heartbeatPending = value;
      },
      get heartbeatTimeoutTimer() {
        return core.heartbeatTimeoutTimer;
      },
      set heartbeatTimeoutTimer(value) {
        core.heartbeatTimeoutTimer = value;
      },
      get lifecycle() {
        return core.lifecycle;
      },
      get cleanupPromise() {
        return core.cleanupPromise;
      },
      set cleanupPromise(value) {
        core.cleanupPromise = value;
      },
      get closeNotified() {
        return core.closeNotified;
      },
      set closeNotified(value) {
        core.closeNotified = value;
      },
      resolveDefaultWorkingDir: () => core.resolveDefaultWorkingDir(),
      shouldInstallGhosttyTerminfo: () => core.shouldInstallGhosttyTerminfo(),
      configureWindowStyle: (styleValue) => core.configureWindowStyle(styleValue),
      getParkingCommand: () => core.getParkingCommand(),
      runTmuxAllowFailure: (argv: string[], timeoutMs?: number) =>
        core.runTmuxAllowFailure(argv, timeoutMs),
      requestSnapshotInternal: () => core.requestSnapshotInternal(),
      requestSnapshot: () => core.requestSnapshot(),
      reportTmuxCommandFailure: (message) => core.reportTmuxCommandFailure(message),
      onTmuxServerGone: (message) => core.onTmuxServerGone(message),
      notifySessionClosed: (message) => core.notifySessionClosed(message),
      shutdownInternal: (notifyClose) => core.shutdownInternal(notifyClose),
      getControlWriter: () => core.getControlWriter(),
      getControlCommandTimeoutMs: () => core.getControlCommandTimeoutMs(),
      runHistoryQuery: (argv) => core.runHistoryQuery(argv),
      runHistoryCapture: (argv, maxOutputBytes) => core.runHistoryCapture(argv, maxOutputBytes),
      createParkingWindow: () => core.createParkingWindow(),
      removeParkingWindow: (windowId) => core.removeParkingWindow(windowId),
      attachControlTransport: (onAttachReady) => core.attachControlTransport(onAttachReady),
      isAttachedControlTransport: (transport) => core.isAttachedControlTransport(transport),
      controlAttachFailureMessage: () => core.controlAttachFailureMessage(),
      onControlAttachPrematureClose: (message) => core.onControlAttachPrematureClose(message),
      killControlTransport: () => core.killControlTransport(),
      detachControlTransport: () => core.detachControlTransport(),
      recordBell: (paneId, windowId) => core.recordBell(paneId, windowId),
      emitNotification: (paneId, notification) => core.emitNotification(paneId, notification),
      noteThemeSubscription: (paneId, subscribed) => core.noteThemeSubscription(paneId, subscribed),
      clearThemeSubscription: (paneId) => core.clearThemeSubscription(paneId),
      sendInput: (paneId, data) => core.sendInput(paneId, data),
      shouldAbortSnapshot: (results) => core.shouldAbortSnapshot(results),
      onSnapshotSuccess: () => core.onSnapshotSuccess(),
      pruneThemeSubscriptions: (paneIds) => core.pruneThemeSubscriptions(paneIds),
      restoreThemeSubscriptionsOnce: () => core.restoreThemeSubscriptionsOnce(),
      markDeviceTmuxUnavailable: (message) => core.markDeviceTmuxUnavailable(message),
      stopControlClient: () => core.stopControlClient(),
      disposeTransport: () => core.disposeTransport(),
    };
  }

  isSessionClosedEmitted(): boolean {
    return this.lifecycle.sessionClosedEmitted;
  }

  protected beginConnectGeneration(): number {
    this.manualDisconnect = false;
    this.closeNotified = false;
    this.lifecycle.reset();
    this.connectGeneration += 1;
    return this.connectGeneration;
  }

  protected invalidateConnectGeneration(): void {
    this.connectGeneration += 1;
  }

  protected isConnectGenerationCurrent(generation: number): boolean {
    return generation === this.connectGeneration && !this.manualDisconnect;
  }

  protected releaseAbortedConnectResources(): void {
    this.connected = false;
    this.stopControlClient();
    void this.disposeTransport();
  }

  protected abandonStaleConnect(generation: number): boolean {
    if (this.isConnectGenerationCurrent(generation)) {
      return false;
    }
    if (this.manualDisconnect) {
      this.releaseAbortedConnectResources();
    }
    return true;
  }

  protected async awaitConnectStep<T>(generation: number, step: () => Promise<T>): Promise<T> {
    try {
      const value = await step();
      if (this.abandonStaleConnect(generation)) {
        throw new ConnectAbandonedError();
      }
      return value;
    } catch (error) {
      if (error instanceof ConnectAbandonedError) {
        throw error;
      }
      if (this.abandonStaleConnect(generation)) {
        throw new ConnectAbandonedError();
      }
      throw error;
    }
  }

  protected async runConnectAttempt(run: (generation: number) => Promise<void>): Promise<void> {
    const generation = this.beginConnectGeneration();
    try {
      await run(generation);
    } catch (error) {
      if (error instanceof ConnectAbandonedError) {
        return;
      }
      throw error;
    }
  }

  protected async finalizeConnect(
    generation: number,
    created: boolean,
    startControl: boolean
  ): Promise<void> {
    const serverEpoch = await this.awaitConnectStep(generation, () =>
      ensureStableServerEpoch((argv) => this.runTmuxAllowFailure(argv))
    );
    this.callbacks.onSourceReady?.(serverEpoch);
    await this.awaitConnectStep(generation, () => this.configureSessionOptions());
    if (startControl) {
      await this.awaitConnectStep(generation, () => this.startControlClient());
    }
    if (this.abandonStaleConnect(generation)) {
      throw new ConnectAbandonedError();
    }
    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
      lastErrorType: null,
    });
    if (created) {
      this.lifecycle.notifySessionCreated();
    }
    await this.awaitConnectStep(generation, () => this.requestSnapshotInternal());
  }

  requestSnapshot(): void {
    void this.snapshotRefreshCoordinator.request().catch((error) => {
      this.handleSnapshotFailure(error);
    });
  }

  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    this.themeController.signalThemeChange(paneId, theme);
  }

  abstract sendInput(paneId: string, data: string): void;

  resizePane(paneId: string, cols: number, rows: number): void {
    this.sessionCommands.resizePane(paneId, cols, rows);
  }

  selectPane(windowId: string, paneId: string): void {
    this.sessionCommands.selectPane(windowId, paneId);
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    this.sessionCommands.selectPaneWithSize(windowId, paneId, cols, rows);
  }

  selectWindow(windowId: string): void {
    this.sessionCommands.selectWindow(windowId);
  }

  createWindow(name?: string, cwd?: string): void {
    this.sessionCommands.createWindow(name, cwd);
  }

  closeWindow(windowId: string): void {
    this.sessionCommands.closeWindow(windowId);
  }

  closePane(paneId: string): void {
    this.sessionCommands.closePane(paneId);
  }

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    this.sessionCommands.splitPane(paneId, direction, cwd);
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    this.sessionCommands.resizePaneById(paneId, size);
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    this.sessionCommands.resizeWindow(windowId, cols, rows);
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    this.sessionCommands.selectLayout(windowId, preset);
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    this.sessionCommands.applyStackedLayout(windowId, cols, rows);
  }

  focusPane(windowId: string, paneId: string): void {
    this.sessionCommands.focusPane(windowId, paneId);
  }

  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    this.sessionCommands.movePane(srcPaneId, dstPaneId, position);
  }

  breakPane(paneId: string): void {
    this.sessionCommands.breakPane(paneId);
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    await this.sessionCommands.requestPaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.sessionCommands.renameWindow(windowId, name);
  }

  updateDefaultWorkingDir(dir: string | undefined): void {
    if (this.device) {
      this.device = { ...this.device, defaultWorkingDir: dir };
    }
    if (this.connected) {
      void this.runTmuxAllowFailure([
        'set-option',
        '-t',
        this.sessionName,
        'default-path',
        this.resolveDefaultWorkingDir(),
      ]);
    }
  }

  async setWindowStyle(style: string): Promise<void> {
    await this.sessionCommands.setWindowStyle(style);
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    return this.sessionCommands.capturePaneText(paneId, opts);
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    return this.sessionCommands.getPaneInfo(paneId);
  }

  async getPaneHistoryCaptureInfo(paneId: string) {
    return this.sessionCommands.getPaneHistoryCaptureInfo(paneId);
  }

  async capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string> {
    return this.sessionCommands.capturePaneHistoryRange(paneId, startLine, endLine, maxOutputBytes);
  }

  capturePaneFrameAtBarrier(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture> {
    return this.sessionCommands.capturePaneFrameAtBarrier(paneId, historyLines, onBarrier);
  }

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    return this.sessionCommands.fetchPaneHistory(paneId);
  }

  protected abstract resolveDefaultWorkingDir(): string;
  protected abstract runTmuxAllowFailure(
    argv: string[],
    timeoutMs?: number
  ): Promise<CommandResult>;
  protected abstract getParkingCommand(): string;
  protected abstract shouldInstallGhosttyTerminfo(): Promise<boolean>;
  protected abstract attachControlTransport(
    onAttachReady: () => void
  ): Promise<ExternalControlHandle>;
  protected abstract isAttachedControlTransport(transport: ExternalControlHandle): boolean;
  protected abstract getControlWriter(): ((data: string) => void) | null;
  protected abstract detachControlTransport(): () => void;
  protected abstract killControlTransport(): void;
  protected abstract controlAttachFailureMessage(): string;
  protected abstract reportTmuxCommandFailure(message: string): void;
  protected abstract runHistoryQuery(argv: string[]): Promise<CommandResult>;
  protected abstract runHistoryCapture(argv: string[], maxOutputBytes: number): Promise<string>;

  protected getControlCommandTimeoutMs(): number {
    return 10_000;
  }

  protected onControlAttachPrematureClose(_message: string): void {}

  protected onTmuxServerGone(_message: string): void {}

  protected shouldAbortSnapshot(_results: CommandResult[]): boolean {
    return false;
  }

  protected onSnapshotSuccess(): void {}

  protected handleSnapshotFailure(_error: unknown): void {}

  protected async disposeTransport(): Promise<void> {}

  protected async ensureSession(): Promise<{ created: boolean }> {
    return this.sessionCommands.ensureSession();
  }

  protected async configureSessionOptions(): Promise<void> {
    return this.sessionCommands.configureSessionOptions();
  }

  // window-style 让 tmux 代答 pane 内 OSC 10/11；控制模式 client 无法上报 tty 颜色，
  // 否则回复纯黑。window option 无 session 层，需逐 window 设置并用 hook 覆盖新窗口。
  protected async configureWindowStyle(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    return this.sessionCommands.configureWindowStyleDefault(styleValue);
  }

  protected async createParkingWindow(): Promise<string | null> {
    return this.sessionCommands.createParkingWindow();
  }

  protected async removeParkingWindow(windowId: string | null): Promise<void> {
    return this.sessionCommands.removeParkingWindow(windowId);
  }

  protected async startControlClient(): Promise<void> {
    this.sessionCommands.invalidateInflightHistory();
    return this.controlLifecycle.startControlClient();
  }

  protected buildControlModeCallbacks(
    onAttachReady: () => void,
    controlCommands: ControlModeCommandQueue,
    write: (data: string) => void,
    isCurrent: () => boolean
  ): ControlModeSubscriptionCallbacks {
    return this.controlLifecycle.buildControlModeCallbacks(
      onAttachReady,
      controlCommands,
      write,
      isCurrent
    );
  }

  protected stopControlClient(): void {
    this.controlLifecycle.stopControlClient();
  }

  protected startHeartbeat(): void {
    this.controlLifecycle.startHeartbeat();
  }

  protected stopHeartbeat(): void {
    this.controlLifecycle.stopHeartbeat();
  }

  protected sendHeartbeat(): void {
    this.controlLifecycle.sendHeartbeat();
  }

  protected onHeartbeatResponse(): void {
    this.controlLifecycle.onHeartbeatResponse();
  }

  protected get themeSubscriptions() {
    return this.themeController.tracker;
  }

  protected noteThemeSubscription(paneId: string, subscribed: boolean): void {
    this.themeController.noteThemeSubscription(paneId, subscribed);
  }

  protected clearThemeSubscription(paneId: string): void {
    this.themeController.clearThemeSubscription(paneId);
  }

  protected restoreThemeSubscriptionsOnce(): void {
    this.themeController.restoreThemeSubscriptionsOnce();
  }

  protected pruneThemeSubscriptions(paneIds: ReadonlySet<string>): void {
    this.themeController.prune(paneIds);
  }

  protected markDeviceTmuxUnavailable(message: string): void {
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
  }

  protected notifySessionClosed(message: string): void {
    this.lifecycle.notifySessionClosed(message);
  }

  protected async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false,
    timeoutMs = 10_000
  ): Promise<CommandResult> {
    return this.sessionCommands.runTmux(argv, allowTargetMissing, timeoutMs);
  }

  protected async capturePaneHistory(paneId: string): Promise<void> {
    return this.sessionCommands.capturePaneHistory(paneId);
  }

  protected async requestSnapshotInternal(): Promise<void> {
    return this.snapshotRefreshCoordinator.requestImmediate();
  }

  protected async performSnapshot(): Promise<void> {
    return this.snapshotProjector.performSnapshot();
  }

  protected recordBell(paneId?: string, windowId?: string): void {
    const key = paneId || windowId || '-';
    if (!noteBellDedup(this.bellDedupBook, key, Date.now())) {
      return;
    }
    this.callbacks.onEvent({
      type: 'bell',
      data: {
        windowId,
        paneId: paneId || this.activePaneId || undefined,
      },
    });
  }

  protected emitNotification(paneId: string, notification: PaneStreamNotification): void {
    this.callbacks.onEvent({
      type: 'notification',
      data: {
        paneId,
        ...notification,
      },
    });
  }

  protected async shutdownInternal(notifyClose: boolean): Promise<void> {
    return this.connectionCleanup.shutdownInternal(notifyClose);
  }
}
