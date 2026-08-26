import { encodePaneModes } from '@tmex/shared';
import type { Device, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';

import { config } from '../config';
import { updateDeviceRuntimeStatus } from '../db';
import {
  PANE_HISTORY_CAPTURE_INFO_FORMAT,
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneHistoryCaptureInfo,
  parsePaneMeta,
  parsePaneScreenInfo,
} from './capture-history';
import type { TmuxConnectionOptions } from './connection-types';
import {
  type AtomicPaneCapture,
  ControlModeCommandQueue,
  capturePaneFrameAtControlBarrier,
} from './control-mode-capture';
import {
  type ControlModeSubscription,
  type ControlModeSubscriptionCallbacks,
  SOURCE_METADATA_SUBSCRIPTION_COMMANDS,
} from './control-mode-subscription';
import { ConnectionLifecycleEmitter } from './lifecycle-emitter';
import type { PaneStreamNotification } from './pane-stream-parser';
import {
  PANE_SNAPSHOT_FORMAT,
  SNAPSHOT_FIELD_SEPARATOR,
  WINDOW_SNAPSHOT_FORMAT,
  formatSnapshotRowForLog,
  isTmuxPaneId,
  isTmuxSessionId,
  isTmuxWindowId,
  parsePaneSnapshotRow,
  parseWindowSnapshotRow,
  splitSnapshotFields,
} from './snapshot-format';
import { SnapshotRefreshCoordinator } from './snapshot-refresh-coordinator';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { createThemeSubscriptionTracker } from './theme-subscriptions';
import { resolveTmuxWindowStyle } from './window-style';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExternalControlHandle {
  write: (data: string) => void;
}

export const BELL_DEDUP_WINDOW_MS = 200;
export const CONTROL_MAX_RESTARTS = 3;
export const CONTROL_RESTART_DELAY_MS = 500;
export const CONTROL_STABLE_RESET_MS = 10_000;
export const CONTROL_STDERR_TAIL_LIMIT = 2048;
export const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const PARKING_WINDOW_NAME = 'tmex-park';

export function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
}

export function isTmuxServerGoneMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no server running on') ||
    normalized.includes('no sessions') ||
    normalized.includes('lost server') ||
    normalized.includes("can't find session") ||
    normalized.includes('session not found') ||
    normalized.includes('no such session')
  );
}

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
  protected stackedLayoutTransition: Promise<void> = Promise.resolve();
  protected bellDedup = new Map<string, number>();
  protected controlSubscription: ControlModeSubscription | null = null;
  protected controlCommands = new ControlModeCommandQueue();
  protected controlStartedAt = 0;
  protected controlRestartCount = 0;
  protected controlStderrTail = '';
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected heartbeatPending = false;
  protected heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  protected themeSubscriptions = createThemeSubscriptionTracker();
  protected themeSubscriptionsRestored = false;

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
  }

  isSessionClosedEmitted(): boolean {
    return this.lifecycle.sessionClosedEmitted;
  }

  requestSnapshot(): void {
    void this.requestSnapshotInternal();
  }

  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    if (!this.connected || !config.themeNotify2031Enabled) {
      return;
    }
    if (!this.themeSubscriptions.has(paneId)) {
      return;
    }
    this.sendInput(paneId, `\x1b[?997;${theme === 'dark' ? '1' : '2'}n`);
  }

  abstract sendInput(paneId: string, data: string): void;

  resizePane(paneId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.resizePaneInternal(paneId, cols, rows).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectPane(windowId: string, paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.selectPaneInternal(windowId, paneId, null).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.selectPaneInternal(windowId, paneId, { cols, rows }).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectWindow(windowId: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['select-window', '-t', windowId], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  createWindow(name?: string, cwd?: string): void {
    if (!this.connected) {
      return;
    }

    const argv = [
      'new-window',
      '-t',
      this.sessionName,
      '-c',
      cwd ?? this.resolveDefaultWorkingDir(),
    ];
    if (name) {
      argv.push('-n', name);
    }
    void this.runAndRefresh(argv).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  closeWindow(windowId: string): void {
    if (!this.connected) {
      return;
    }

    void this.closeWindowInternal(windowId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  closePane(paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['kill-pane', '-t', paneId], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    if (!this.connected) {
      return;
    }

    void this.splitPaneInternal(paneId, direction, cwd).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    if (!this.connected) {
      return;
    }

    void this.resizePaneByIdInternal(paneId, size).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.resizeWindowInternal(windowId, cols, rows).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['select-layout', '-t', windowId, preset], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    const next = this.stackedLayoutTransition
      .catch(() => undefined)
      .then(async () => {
        if (!this.connected) {
          return;
        }
        await this.resizeWindowInternal(windowId, cols, rows, false);
        if (!this.connected) {
          return;
        }
        await this.runAndRefresh(['select-layout', '-t', windowId, 'even-horizontal'], true);
      });
    this.stackedLayoutTransition = next;
    void next.catch((error) => {
      this.callbacks.onError(error);
    });
  }

  focusPane(windowId: string, paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.focusPaneInternal(windowId, paneId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    if (!this.connected) {
      return;
    }

    const argv = ['move-pane'];
    argv.push(position === 'left' || position === 'right' ? '-h' : '-v');
    if (position === 'left' || position === 'top') {
      argv.push('-b');
    }
    argv.push('-s', srcPaneId, '-t', dstPaneId);
    void this.runAndRefresh(argv, true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  breakPane(paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.breakPaneInternal(paneId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.capturePaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['rename-window', '-t', windowId, name]).catch((error) => {
      this.callbacks.onError(error);
    });
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
    if (!this.connected) {
      return;
    }
    if (!resolveTmuxWindowStyle(config.tmuxWindowStyle)) {
      return;
    }

    await this.configureWindowStyle(style).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }

    const argv = ['capture-pane', '-t', paneId, '-p', '-J'];
    const historyLines = Math.floor(opts?.historyLines ?? 0);
    if (Number.isFinite(historyLines) && historyLines > 0) {
      argv.push('-S', `-${historyLines}`);
    }
    return (await this.runTmux(argv, 'silent', 30_000)).stdout;
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }
    const { stdout } = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_META_FORMAT],
      'silent',
      30_000
    );
    return parsePaneMeta(stdout);
  }

  async getPaneHistoryCaptureInfo(paneId: string) {
    if (!this.connected) throw new Error(`tmux connection not available: ${this.deviceId}`);
    const { stdout } = await this.runHistoryQuery([
      'display-message',
      '-p',
      '-t',
      paneId,
      PANE_HISTORY_CAPTURE_INFO_FORMAT,
    ]);
    return parsePaneHistoryCaptureInfo(stdout);
  }

  async capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string> {
    if (!this.connected) throw new Error(`tmux connection not available: ${this.deviceId}`);
    if (!isTmuxPaneId(paneId) || !Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error('invalid tmux history range');
    }
    return this.runHistoryCapture(
      [
        'capture-pane',
        '-t',
        paneId,
        '-p',
        '-e',
        '-N',
        '-S',
        String(startLine),
        '-E',
        String(endLine),
      ],
      maxOutputBytes
    );
  }

  capturePaneFrameAtBarrier(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture> {
    const write = this.getControlWriter();
    if (!this.connected || !write) {
      return Promise.reject(new Error(`tmux control connection not available: ${this.deviceId}`));
    }
    return capturePaneFrameAtControlBarrier(
      this.controlCommands,
      (command) => write(command),
      paneId,
      historyLines,
      onBarrier,
      this.getControlCommandTimeoutMs()
    );
  }

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    const screenInfo = parsePaneScreenInfo(
      (await this.runTmux(['display-message', '-p', '-t', paneId, PANE_SCREEN_INFO_FORMAT], true))
        .stdout
    );
    const alternateScreen = screenInfo.alternateScreen;
    const normal = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-S', '-', '-E', '-', '-e', '-J', '-N', '-p'],
        true,
        30_000
      )
    ).stdout;
    const alternate = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-a', '-S', '-', '-E', '-', '-e', '-J', '-N', '-p', '-q'],
        true,
        30_000
      )
    ).stdout;

    const history = alternateScreen
      ? hasRenderableTerminalContent(normal)
        ? normal
        : alternate
      : normal || alternate;

    if (!history) {
      return null;
    }
    return {
      data: appendCursorRestore(history, screenInfo),
      alternateScreen,
      modes: encodePaneModes(screenInfo.modes),
    };
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

  protected async disposeTransport(): Promise<void> {}

  protected async ensureSession(): Promise<{ created: boolean }> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return { created: false };
    }

    await this.runTmux([
      'new-session',
      '-d',
      '-c',
      this.resolveDefaultWorkingDir(),
      '-s',
      this.sessionName,
    ]);
    return { created: true };
  }

  protected async configureSessionOptions(): Promise<void> {
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-s',
      'allow-passthrough',
      config.tmuxAllowPassthrough ? 'on' : 'off',
    ]);
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-g',
      'extended-keys',
      'on',
    ]);
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-s',
      'extended-keys-format',
      'csi-u',
    ]);
    // control client 自带 attached+focused 标志，focus-events on 会把 ESC[I 投递给
    // ?1004h 的 pane（如 Claude Code），使其永久判定「用户在场」、通知静默，必须关闭。
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-g',
      'focus-events',
      'off',
    ]);
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      'destroy-unattached',
      'off',
    ]);

    const termProgram = config.tmuxTermProgram.trim();
    if (termProgram && termProgram.toLowerCase() !== 'off') {
      await this.runTmuxAllowFailure([
        'set-environment',
        '-t',
        this.sessionName,
        'TERM_PROGRAM',
        termProgram,
      ]);
      if (termProgram === 'ghostty' && (await this.shouldInstallGhosttyTerminfo())) {
        await this.runTmuxAllowFailure([
          'set-option',
          '-t',
          this.sessionName,
          'default-terminal',
          'xterm-ghostty',
        ]);
      }
    }

    await this.runTmuxAllowFailure([
      'set-environment',
      '-t',
      this.sessionName,
      'COLORTERM',
      'truecolor',
    ]);

    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      'default-path',
      this.resolveDefaultWorkingDir(),
    ]);

    await this.configureWindowStyle();
  }

  // window-style 让 tmux 代答 pane 内 OSC 10/11；控制模式 client 无法上报 tty 颜色，
  // 否则回复纯黑。window option 无 session 层，需逐 window 设置并用 hook 覆盖新窗口。
  protected async configureWindowStyle(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    const windowStyle = resolveTmuxWindowStyle(styleValue);
    if (!windowStyle) {
      return;
    }
    await this.runTmuxAllowFailure([
      'set-hook',
      '-t',
      this.sessionName,
      'after-new-window',
      `set-option -w window-style '${windowStyle}'`,
    ]);
    const windows = await this.runTmuxAllowFailure([
      'list-windows',
      '-t',
      this.sessionName,
      '-F',
      '#{window_id}',
    ]);
    if (windows.exitCode !== 0) {
      return;
    }
    for (const line of windows.stdout.split('\n')) {
      const windowId = line.trim();
      if (!windowId) {
        continue;
      }
      await this.runTmuxAllowFailure([
        'set-option',
        '-w',
        '-t',
        windowId,
        'window-style',
        windowStyle,
      ]);
    }
  }

  // attach 时 tmux 会向当前窗口活动 pane 投递焦点事件（不受 focus-events 约束）。
  // 若该 pane 开了 ?1004h，ESC[I 会让 TUI 永久判定用户在场。attach 前切到一次性
  // parking 窗口，让焦点事件落空，attach 完成后切回并清理。
  protected async createParkingWindow(): Promise<string | null> {
    const result = await this.runTmuxAllowFailure([
      'new-window',
      '-t',
      this.sessionName,
      '-n',
      PARKING_WINDOW_NAME,
      '-P',
      '-F',
      '#{window_id}',
      this.getParkingCommand(),
    ]);
    if (result.exitCode !== 0) {
      console.warn(
        `${this.logPrefix} failed to create parking window on ${this.deviceId}, attaching without focus shield`
      );
      return null;
    }
    return result.stdout.trim() || null;
  }

  protected async removeParkingWindow(windowId: string | null): Promise<void> {
    if (!windowId) {
      return;
    }
    await this.runTmuxAllowFailure(['last-window', '-t', this.sessionName]);
    await this.runTmuxAllowFailure(['kill-window', '-t', windowId]);
  }

  protected async startControlClient(): Promise<void> {
    this.stopHeartbeat();

    let attachReadyResolve: (() => void) | null = null;
    const attachReady = new Promise<void>((resolve) => {
      attachReadyResolve = resolve;
    });

    const parkingWindowId = await this.createParkingWindow();
    let transport: ExternalControlHandle;
    try {
      transport = await this.attachControlTransport(() => {
        attachReadyResolve?.();
        attachReadyResolve = null;
      });
      await Promise.race([
        attachReady,
        new Promise<void>((resolve) => setTimeout(resolve, CONTROL_ATTACH_READY_TIMEOUT_MS)),
      ]);
    } finally {
      await this.removeParkingWindow(parkingWindowId);
    }

    if (!this.isAttachedControlTransport(transport)) {
      const message = this.controlStderrTail.trim() || this.controlAttachFailureMessage();
      this.onControlAttachPrematureClose(message);
      throw new Error(message);
    }

    for (const command of SOURCE_METADATA_SUBSCRIPTION_COMMANDS) {
      void this.controlCommands
        .execute((value) => transport.write(value), command, { transform: () => undefined })
        .catch((error) => this.callbacks.onError(error));
    }

    this.startHeartbeat();
  }

  protected buildControlModeCallbacks(
    onAttachReady: () => void,
    controlCommands: ControlModeCommandQueue,
    write: (data: string) => void,
    isCurrent: () => boolean
  ): ControlModeSubscriptionCallbacks {
    return {
      onTerminalOutput: (paneId, data) => {
        this.callbacks.onTerminalOutput(paneId, data);
      },
      onTitle: (paneId, title) => {
        this.callbacks.onSourceMetadata?.({ type: 'pane-title', paneId, title });
      },
      onSourceMetadata: (event) => {
        this.callbacks.onSourceMetadata?.(event);
      },
      onBell: (paneId) => {
        this.recordBell(paneId);
      },
      onNotification: (paneId, notification) => {
        this.emitNotification(paneId, notification);
      },
      onPromptMarker: (paneId, marker) => {
        if (marker.kind === 'A') {
          this.clearThemeSubscription(paneId);
        }
        this.callbacks.onPromptMarker?.(paneId, marker);
      },
      onClipboardWrite: (paneId, text) => {
        this.callbacks.onClipboardWrite?.(paneId, text);
      },
      onThemeSubscription: (paneId, subscribed) => {
        this.noteThemeSubscription(paneId, subscribed);
      },
      onStructureChanged: () => {
        this.requestSnapshot();
      },
      onExit: () => {},
      onPause: (paneId) => {
        if (!isCurrent()) {
          return;
        }
        void controlCommands
          .execute((value) => write(value), `refresh-client -A ${paneId}:continue`, {
            transform: () => undefined,
          })
          .catch((error) => this.callbacks.onError(error));
      },
      onBlockBegin: () => controlCommands.nextBlockIsLiteral(),
      onBlockEnd: (block) => {
        if (controlCommands.handleBlock(block)) return;
        onAttachReady();
      },
    };
  }

  protected stopControlClient(): void {
    this.stopHeartbeat();
    const killDetached = this.detachControlTransport();
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    this.controlCommands.dispose();
    killDetached();
  }

  protected startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  protected stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    this.heartbeatPending = false;
  }

  protected sendHeartbeat(): void {
    const write = this.getControlWriter();
    if (!write || this.heartbeatPending || !this.connected || this.manualDisconnect) {
      return;
    }
    this.heartbeatPending = true;
    void this.controlCommands
      .execute((value) => write(value), 'display-message -p "tmex-hb"', {
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        transform: (block) => {
          if (block.lines.length !== 1 || block.lines[0] !== 'tmex-hb') {
            throw new Error('invalid tmux heartbeat response');
          }
        },
      })
      .then(() => this.onHeartbeatResponse())
      .catch(() => {});
    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (!this.heartbeatPending || !this.connected || this.manualDisconnect) {
        return;
      }
      console.warn(
        `${this.logPrefix} tmux control client heartbeat timeout on ${this.deviceId}, killing stalled ${this.stalledControlLabel}`
      );
      this.killControlTransport();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  protected onHeartbeatResponse(): void {
    if (!this.heartbeatPending) {
      return;
    }
    this.heartbeatPending = false;
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  protected noteThemeSubscription(paneId: string, subscribed: boolean): void {
    this.themeSubscriptions.note(paneId, subscribed);
    void this.runTmuxAllowFailure([
      'set-option',
      '-p',
      '-t',
      paneId,
      '@tmex_2031',
      subscribed ? 'on' : 'off',
    ]).catch(() => {});
  }

  protected clearThemeSubscription(paneId: string): void {
    if (!this.themeSubscriptions.has(paneId)) {
      return;
    }
    this.themeSubscriptions.clear(paneId);
    void this.runTmuxAllowFailure(['set-option', '-p', '-t', paneId, '@tmex_2031', 'off']).catch(
      () => {}
    );
  }

  protected restoreThemeSubscriptionsOnce(): void {
    if (this.themeSubscriptionsRestored) {
      return;
    }
    this.themeSubscriptionsRestored = true;
    void this.runTmuxAllowFailure(['list-panes', '-a', '-F', '#{pane_id}|#{@tmex_2031}'])
      .then((result) => {
        if (!result || result.exitCode !== 0) {
          return;
        }
        const restored: string[] = [];
        for (const line of result.stdout.split('\n')) {
          const [paneId, flag] = line.trim().split('|');
          if (paneId && flag === 'on') {
            restored.push(paneId);
          }
        }
        this.themeSubscriptions.restore(restored);
      })
      .catch(() => {});
  }

  protected async runAndRefresh(argv: string[], allowTargetMissing = false): Promise<void> {
    await this.runTmux(argv, allowTargetMissing);
    await this.requestSnapshotInternal();
  }

  protected async closeWindowInternal(windowId: string): Promise<void> {
    const count = Number.parseInt(
      (
        await this.runTmux(['display-message', '-p', '-t', this.sessionName, '#{session_windows}'])
      ).stdout.trim() || '0',
      10
    );

    if (count <= 1) {
      await this.runTmux([
        'new-window',
        '-d',
        '-t',
        this.sessionName,
        '-c',
        this.resolveDefaultWorkingDir(),
      ]);
    }

    await this.runAndRefresh(['kill-window', '-t', windowId], true);
  }

  protected async resizePaneInternal(paneId: string, cols: number, rows: number): Promise<void> {
    const windowId =
      this.findPaneWindowId(paneId) ??
      (
        await this.runTmux(['display-message', '-p', '-t', paneId, '#{window_id}'], true)
      ).stdout.trim();
    if (!windowId) {
      return;
    }

    await this.resizeWindowInternal(windowId, cols, rows);
  }

  protected async resizeWindowInternal(
    windowId: string,
    cols: number,
    rows: number,
    refresh = true
  ): Promise<void> {
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(2, Math.floor(rows));
    await this.runTmux(
      ['resize-window', '-t', windowId, '-x', String(safeCols), '-y', String(safeRows)],
      true
    );
    if (refresh) {
      await this.requestSnapshotInternal();
    }
  }

  protected async resizePaneByIdInternal(
    paneId: string,
    size: { cols?: number; rows?: number }
  ): Promise<void> {
    const argv = ['resize-pane', '-t', paneId];
    if (size.cols !== undefined) {
      argv.push('-x', String(Math.max(2, Math.floor(size.cols))));
    }
    if (size.rows !== undefined) {
      argv.push('-y', String(Math.max(2, Math.floor(size.rows))));
    }
    if (argv.length === 3) {
      return;
    }
    await this.runTmux(argv, true);
    await this.requestSnapshotInternal();
  }

  protected async splitPaneInternal(
    paneId: string,
    direction: 'h' | 'v',
    cwd?: string
  ): Promise<void> {
    const result = await this.runTmux(
      [
        'split-window',
        direction === 'h' ? '-h' : '-v',
        '-t',
        paneId,
        '-c',
        cwd ?? this.resolveDefaultWorkingDir(),
        '-P',
        '-F',
        `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
      ],
      true
    );
    const [windowId, newPaneId] = result.stdout.trim().split(SNAPSHOT_FIELD_SEPARATOR);
    if (isTmuxWindowId(windowId) && isTmuxPaneId(newPaneId)) {
      this.activeWindowId = windowId;
      this.activePaneId = newPaneId;
      this.callbacks.onEvent({
        type: 'pane-active',
        data: { windowId, paneId: newPaneId },
      });
    }
    await this.requestSnapshotInternal();
  }

  protected async focusPaneInternal(windowId: string, paneId: string): Promise<void> {
    this.activeWindowId = windowId;
    this.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    this.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
    await this.requestSnapshotInternal();
  }

  protected async selectPaneInternal(
    windowId: string,
    paneId: string,
    size: { cols: number; rows: number } | null
  ): Promise<void> {
    this.activeWindowId = windowId;
    this.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    if (size) {
      await this.resizePaneInternal(paneId, size.cols, size.rows);
    }

    this.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
    await this.capturePaneHistory(paneId);
    await this.requestSnapshotInternal();
  }

  // 必须显式 -t 回本 session：无 attached client 时 break-pane 默认目标是最近使用的
  // session，会把 pane 丢进用户的其他 session。-P 回传新窗口并驱动 pane-active。
  protected async breakPaneInternal(paneId: string): Promise<void> {
    const result = await this.runTmux(
      [
        'break-pane',
        '-s',
        paneId,
        '-t',
        `${this.sessionName}:`,
        '-P',
        '-F',
        `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
      ],
      true
    );
    const [windowId, newPaneId] = result.stdout.trim().split(SNAPSHOT_FIELD_SEPARATOR);
    if (isTmuxWindowId(windowId) && isTmuxPaneId(newPaneId)) {
      this.activeWindowId = windowId;
      this.activePaneId = newPaneId;
      this.callbacks.onEvent({
        type: 'pane-active',
        data: { windowId, paneId: newPaneId },
      });
    }
    await this.requestSnapshotInternal();
  }

  protected async capturePaneHistory(paneId: string): Promise<void> {
    const captured = await this.fetchPaneHistory(paneId);
    if (captured) {
      this.callbacks.onTerminalHistory(
        paneId,
        captured.data,
        captured.alternateScreen,
        captured.modes
      );
    }
  }

  protected async requestSnapshotInternal(): Promise<void> {
    return this.snapshotRefreshCoordinator.request();
  }

  protected async performSnapshot(): Promise<void> {
    if (!this.connected) {
      return;
    }

    const baseRevision = this.callbacks.beginMetadataReconcile?.();

    const [sessionRes, windowsRes, panesRes] = await Promise.all([
      this.runTmuxAllowFailure([
        'display-message',
        '-p',
        '-t',
        this.sessionName,
        ['#{session_id}', '#{session_name}'].join(SNAPSHOT_FIELD_SEPARATOR),
      ]),
      this.runTmuxAllowFailure([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        WINDOW_SNAPSHOT_FORMAT,
      ]),
      this.runTmuxAllowFailure([
        'list-panes',
        '-s',
        '-t',
        this.sessionName,
        '-F',
        PANE_SNAPSHOT_FORMAT,
      ]),
    ]);

    if (this.shouldAbortSnapshot([sessionRes, windowsRes, panesRes])) {
      return;
    }

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      const stderrBlob = `${sessionRes.stderr}\n${windowsRes.stderr}\n${panesRes.stderr}`;
      if (this.connected && !this.manualDisconnect && isTmuxServerGoneMessage(stderrBlob)) {
        const message =
          stderrBlob
            .trim()
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim() ?? 'tmux server gone';
        console.warn(
          `${this.logPrefix} tmux server gone during snapshot on ${this.deviceId}: ${message}`
        );
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: message,
        });
        this.lifecycle.notifySessionClosed(message);
        void this.shutdownInternal(true);
        return;
      }
      this.callbacks.onSnapshot({ deviceId: this.deviceId, session: null });
      return;
    }

    const prevWindows = new Map(this.snapshotWindows);
    this.parseSnapshotSession(sessionRes.stdout.split(/\r?\n/));
    this.parseSnapshotWindows(windowsRes.stdout.split(/\r?\n/));
    this.parseSnapshotPanes(panesRes.stdout.split(/\r?\n/));
    this.discardInvalidSnapshot();
    const expectedPaneIds = new Set(this.getExpectedPaneIds());
    this.controlSubscription?.prunePanes(expectedPaneIds);
    this.themeSubscriptions.prune(expectedPaneIds);
    this.restoreThemeSubscriptionsOnce();
    this.onSnapshotSuccess();
    this.emitSnapshot(baseRevision);
    this.lifecycle.emitSnapshotClosures(prevWindows);
  }

  protected parseSnapshotSession(lines: string[]): void {
    this.snapshotSession = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const [id, name] = splitSnapshotFields(line, 2);
      if (isTmuxSessionId(id)) {
        this.snapshotSession = { id, name: name ?? '' };
      } else {
        console.warn(
          `${this.logPrefix} ignoring invalid tmux session id on ${this.deviceId}: ${id ?? ''}`
        );
      }
      return;
    }
  }

  protected parseSnapshotWindows(lines: string[]): void {
    this.snapshotWindows.clear();
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const row = parseWindowSnapshotRow(line);
      if (!row) {
        console.warn(
          `${this.logPrefix} ignoring invalid tmux window snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      if (row.active) {
        this.activeWindowId = row.id;
      }
      this.snapshotWindows.set(row.id, {
        id: row.id,
        index: row.index,
        name: row.name,
        active: row.active,
        layout: row.layout,
        panes: [],
      });
    }
  }

  protected parseSnapshotPanes(lines: string[]): void {
    for (const window of this.snapshotWindows.values()) {
      window.panes = [];
    }

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const row = parsePaneSnapshotRow(line);
      if (!row) {
        console.warn(
          `${this.logPrefix} ignoring invalid tmux pane snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      const pane: TmuxPane = {
        id: row.id,
        windowId: row.windowId,
        index: row.index,
        title: row.title ?? '',
        currentCommand: row.currentCommand,
        currentPath: row.currentPath,
        active: row.active,
        width: row.width,
        height: row.height,
        left: row.left,
        top: row.top,
      };

      if (pane.active && row.windowActive) {
        this.activePaneId = row.id;
        this.activeWindowId = row.windowId;
      }

      const window = this.snapshotWindows.get(row.windowId);
      if (!window) {
        continue;
      }
      window.panes.push(pane);
    }

    for (const window of this.snapshotWindows.values()) {
      window.panes.sort((left, right) => left.index - right.index);
    }
  }

  protected isSnapshotFlag(value: string | undefined): value is '0' | '1' {
    return value === '0' || value === '1';
  }

  protected discardInvalidSnapshot(): void {
    if (!this.snapshotSession) {
      this.snapshotWindows.clear();
      this.activeWindowId = null;
      this.activePaneId = null;
      return;
    }

    if (this.snapshotWindows.size === 0) {
      console.warn(
        `${this.logPrefix} ignoring tmux snapshot with no valid windows on ${this.deviceId}`
      );
      this.snapshotSession = null;
      this.activeWindowId = null;
      this.activePaneId = null;
    }
  }

  protected emitSnapshot(baseRevision?: bigint): void {
    const session = this.snapshotSession
      ? {
          id: this.snapshotSession.id,
          name: this.snapshotSession.name,
          windows: Array.from(this.snapshotWindows.values()).sort(
            (left, right) => left.index - right.index
          ),
        }
      : null;

    this.callbacks.onSnapshot(
      {
        deviceId: this.deviceId,
        session,
      },
      baseRevision
    );
  }

  protected findPaneWindowId(paneId: string): string | null {
    for (const window of this.snapshotWindows.values()) {
      if (window.panes.some((pane) => pane.id === paneId)) {
        return window.id;
      }
    }
    return null;
  }

  protected recordBell(paneId?: string, windowId?: string): void {
    const key = paneId || windowId || '-';
    const previous = this.bellDedup.get(key) ?? 0;
    const now = Date.now();
    if (now - previous < BELL_DEDUP_WINDOW_MS) {
      return;
    }
    this.bellDedup.set(key, now);
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

  protected getExpectedPaneIds(): string[] {
    return Array.from(this.snapshotWindows.values())
      .sort((left, right) => left.index - right.index)
      .flatMap((window) => window.panes.map((pane) => pane.id));
  }

  // allowTargetMissing: false=失败即告警并抛错；true=target missing 静默恢复；
  // 'silent'=抛 TmuxTargetMissingError，不告警、不污染设备状态。
  protected async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false,
    timeoutMs = 10_000
  ): Promise<CommandResult> {
    const result = await this.runTmuxAllowFailure(argv, timeoutMs);
    if (result.exitCode === 0) {
      return result;
    }

    const message = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tmux command failed: ${argv.join(' ')}`
    ).trim();
    if (allowTargetMissing && isTargetMissingMessage(message)) {
      if (allowTargetMissing === 'silent') {
        throw new TmuxTargetMissingError(message);
      }
      this.recoverFromTargetMissingError(message);
      return result;
    }

    console.warn(
      `${this.logPrefix} tmux command failed deviceId=${this.deviceId} sessionName=${this.sessionName} argv=${argv.join(' ')} exitCode=${result.exitCode}: ${message}`
    );
    this.reportTmuxCommandFailure(message);
    if (this.connected && !this.manualDisconnect && isTmuxServerGoneMessage(message)) {
      console.warn(`${this.logPrefix} tmux server gone on ${this.deviceId}: ${message}`);
      this.onTmuxServerGone(message);
      this.lifecycle.notifySessionClosed(message);
      void this.shutdownInternal(true);
    }
    throw new Error(message);
  }

  protected recoverFromTargetMissingError(message: string): void {
    const normalized = message.toLowerCase();
    if (normalized.includes('window')) {
      this.activeWindowId = null;
    }
    if (normalized.includes('pane')) {
      this.activePaneId = null;
    }
    this.requestSnapshot();
  }

  protected async shutdownInternal(notifyClose: boolean): Promise<void> {
    if (this.cleanupPromise) {
      await this.cleanupPromise;
      if (notifyClose && !this.closeNotified && !this.manualDisconnect) {
        this.closeNotified = true;
        this.callbacks.onClose();
      }
      return;
    }

    this.connected = false;
    this.cleanupPromise = (async () => {
      this.stopControlClient();
      await this.disposeTransport();
    })();

    await this.cleanupPromise;
    this.cleanupPromise = null;

    if (notifyClose && !this.closeNotified && !this.manualDisconnect) {
      this.closeNotified = true;
      this.callbacks.onClose();
    }
  }
}
