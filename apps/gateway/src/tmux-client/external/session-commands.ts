import { encodePaneModes } from '@tmex/shared';
import type { TmuxWindow } from '@tmex/shared';

import { config } from '../../config';
import {
  PANE_HISTORY_CAPTURE_INFO_FORMAT,
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneHistoryCaptureInfo,
  parsePaneMeta,
  parsePaneScreenInfo,
} from '../capture-history';
import type { TmuxConnectionOptions } from '../connection-types';
import {
  type AtomicPaneCapture,
  type ControlModeCommandQueue,
  MAX_PANE_HISTORY_CAPTURE_BYTES,
  MAX_PANE_HISTORY_LINES,
  capturePaneFrameAtControlBarrier,
} from '../control-mode-capture';
import { SNAPSHOT_FIELD_SEPARATOR, isTmuxPaneId, isTmuxWindowId } from '../snapshot-format';
import { TmuxTargetMissingError, isTargetMissingMessage } from '../target-missing';
import { resolveTmuxWindowStyle } from '../window-style';
import { logTmuxDestroy } from './destroy-log';
import { hasRenderableTerminalContent, isTmuxServerGoneMessage } from './helpers';
import { createParkingWindow, removeParkingWindow } from './parking-window';
import type { CommandResult } from './types';

export interface SessionCommandHost {
  deviceId: string;
  sessionName: string;
  connected: boolean;
  manualDisconnect: boolean;
  logPrefix: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  snapshotWindows: Map<string, TmuxWindow>;
  callbacks: TmuxConnectionOptions;
  controlCommands: ControlModeCommandQueue;
  resolveDefaultWorkingDir(): string;
  shouldInstallGhosttyTerminfo(): Promise<boolean>;
  configureWindowStyle(styleValue?: string): Promise<void>;
  getParkingCommand(): string;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
  requestSnapshotInternal(): Promise<void>;
  requestSnapshot(): void;
  reportTmuxCommandFailure(message: string): void;
  onTmuxServerGone(message: string): void;
  notifySessionClosed(message: string): void;
  shutdownInternal(notifyClose: boolean): Promise<void>;
  getControlWriter(): ((data: string) => void) | null;
  getControlCommandTimeoutMs(): number;
  runHistoryQuery(argv: string[]): Promise<CommandResult>;
  runHistoryCapture(argv: string[], maxOutputBytes: number): Promise<string>;
}

export function buildCreateWindowArgv(sessionName: string, cwd: string, name?: string): string[] {
  const argv = ['new-window', '-t', sessionName, '-c', cwd];
  if (name) {
    argv.push('-n', name);
  }
  return argv;
}

export function buildMovePaneArgv(
  srcPaneId: string,
  dstPaneId: string,
  position: 'left' | 'right' | 'top' | 'bottom'
): string[] {
  const argv = ['move-pane'];
  argv.push(position === 'left' || position === 'right' ? '-h' : '-v');
  if (position === 'left' || position === 'top') {
    argv.push('-b');
  }
  argv.push('-s', srcPaneId, '-t', dstPaneId);
  return argv;
}

export function buildSplitPaneArgv(paneId: string, direction: 'h' | 'v', cwd: string): string[] {
  return [
    'split-window',
    direction === 'h' ? '-h' : '-v',
    '-t',
    paneId,
    '-c',
    cwd,
    '-P',
    '-F',
    `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
  ];
}

export function buildBreakPaneArgv(paneId: string, sessionName: string): string[] {
  return [
    'break-pane',
    '-s',
    paneId,
    '-t',
    `${sessionName}:`,
    '-P',
    '-F',
    `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
  ];
}

export function buildResizePaneByIdArgv(
  paneId: string,
  size: { cols?: number; rows?: number }
): string[] | null {
  const argv = ['resize-pane', '-t', paneId];
  if (size.cols !== undefined) {
    argv.push('-x', String(Math.max(2, Math.floor(size.cols))));
  }
  if (size.rows !== undefined) {
    argv.push('-y', String(Math.max(2, Math.floor(size.rows))));
  }
  if (argv.length === 3) {
    return null;
  }
  return argv;
}

export class SessionCommands {
  private stackedLayoutTransition: Promise<void> = Promise.resolve();
  private historyTransportGeneration = 0;
  private readonly paneHistoryInflight = new Map<
    string,
    Promise<{ data: string; alternateScreen: boolean; modes: number } | null>
  >();

  constructor(private readonly host: SessionCommandHost) {}

  invalidateInflightHistory(): void {
    this.historyTransportGeneration += 1;
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    this.fire(() => this.resizePaneInternal(paneId, cols, rows));
  }

  selectPane(windowId: string, paneId: string): void {
    this.fire(() => this.selectPaneInternal(windowId, paneId, null));
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    this.fire(() => this.selectPaneInternal(windowId, paneId, { cols, rows }));
  }

  selectWindow(windowId: string): void {
    this.fire(() => this.runAndRefresh(['select-window', '-t', windowId], true));
  }

  createWindow(name?: string, cwd?: string): void {
    this.fire(() =>
      this.runAndRefresh(
        buildCreateWindowArgv(
          this.host.sessionName,
          cwd ?? this.host.resolveDefaultWorkingDir(),
          name
        )
      )
    );
  }

  closeWindow(windowId: string): void {
    this.fire(() => this.closeWindowInternal(windowId));
  }

  closePane(paneId: string): void {
    logTmuxDestroy(this.host, 'kill-pane', paneId);
    this.fire(() => this.runAndRefresh(['kill-pane', '-t', paneId], true));
  }

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    this.fire(() => this.splitPaneInternal(paneId, direction, cwd));
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    this.fire(() => this.resizePaneByIdInternal(paneId, size));
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    this.fire(() => this.resizeWindowInternal(windowId, cols, rows));
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    this.fire(() => this.runAndRefresh(['select-layout', '-t', windowId, preset], true));
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    if (!this.host.connected) {
      return;
    }

    const next = this.stackedLayoutTransition
      .catch(() => undefined)
      .then(async () => {
        if (!this.host.connected) {
          return;
        }
        await this.resizeWindowInternal(windowId, cols, rows, false);
        if (!this.host.connected) {
          return;
        }
        await this.runAndRefresh(['select-layout', '-t', windowId, 'even-horizontal'], true);
      });
    this.stackedLayoutTransition = next;
    void next.catch((error) => {
      this.host.callbacks.onError(error);
    });
  }

  focusPane(windowId: string, paneId: string): void {
    this.fire(() => this.focusPaneInternal(windowId, paneId));
  }

  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    this.fire(() => this.runAndRefresh(buildMovePaneArgv(srcPaneId, dstPaneId, position), true));
  }

  breakPane(paneId: string): void {
    this.fire(() => this.breakPaneInternal(paneId));
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    if (!this.host.connected) {
      return;
    }
    await this.capturePaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.fire(() => this.runAndRefresh(['rename-window', '-t', windowId, name]));
  }

  async setWindowStyle(style: string): Promise<void> {
    if (!this.host.connected) {
      return;
    }
    if (!resolveTmuxWindowStyle(config.tmuxWindowStyle)) {
      return;
    }

    await this.host.configureWindowStyle(style).catch((error) => {
      this.host.callbacks.onError(error);
    });
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    if (!this.host.connected) {
      throw new Error(`tmux connection not available: ${this.host.deviceId}`);
    }

    const argv = ['capture-pane', '-t', paneId, '-p', '-J'];
    const historyLines = Math.floor(opts?.historyLines ?? 0);
    if (Number.isFinite(historyLines) && historyLines > 0) {
      argv.push('-S', `-${historyLines}`);
    }
    return (await this.runTmux(argv, 'silent', 30_000)).stdout;
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    if (!this.host.connected) {
      throw new Error(`tmux connection not available: ${this.host.deviceId}`);
    }
    const { stdout } = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_META_FORMAT],
      'silent',
      30_000
    );
    return parsePaneMeta(stdout);
  }

  async getPaneHistoryCaptureInfo(paneId: string) {
    if (!this.host.connected) {
      throw new Error(`tmux connection not available: ${this.host.deviceId}`);
    }
    const { stdout } = await this.host.runHistoryQuery([
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
    if (!this.host.connected) {
      throw new Error(`tmux connection not available: ${this.host.deviceId}`);
    }
    if (!isTmuxPaneId(paneId) || !Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error('invalid tmux history range');
    }
    return this.host.runHistoryCapture(
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
    const write = this.host.getControlWriter();
    if (!this.host.connected || !write) {
      return Promise.reject(
        new Error(`tmux control connection not available: ${this.host.deviceId}`)
      );
    }
    return capturePaneFrameAtControlBarrier(
      this.host.controlCommands,
      (command) => write(command),
      paneId,
      historyLines,
      onBarrier,
      this.host.getControlCommandTimeoutMs()
    );
  }

  async fetchPaneHistory(
    paneId: string,
    byteLimit?: number
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    const captureLimit =
      byteLimit != null && Number.isSafeInteger(byteLimit) && byteLimit > 0
        ? Math.min(byteLimit, MAX_PANE_HISTORY_CAPTURE_BYTES)
        : MAX_PANE_HISTORY_CAPTURE_BYTES;
    const key = `${this.historyTransportGeneration}:${paneId}:${captureLimit}`;
    const existing = this.paneHistoryInflight.get(key);
    if (existing) return existing;
    const pending = this.fetchPaneHistoryUncached(paneId, captureLimit).finally(() => {
      if (this.paneHistoryInflight.get(key) === pending) {
        this.paneHistoryInflight.delete(key);
      }
    });
    this.paneHistoryInflight.set(key, pending);
    return pending;
  }

  private async fetchPaneHistoryUncached(
    paneId: string,
    captureLimit: number
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    const screenResult = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_SCREEN_INFO_FORMAT],
      true
    );
    if (screenResult.exitCode !== 0) {
      return null;
    }
    const screenRaw = screenResult.stdout;
    const screenInfo = parsePaneScreenInfo(screenRaw);
    const alternateOn = parseAlternateOnFlag(screenRaw);

    const capture = (alternate: boolean): Promise<string> =>
      this.host.runHistoryCapture(buildLegacyHistoryCaptureArgv(paneId, alternate), captureLimit);

    let history: string;
    try {
      if (alternateOn === null) {
        const normal = await capture(false);
        const alternate = await capture(true);
        history = screenInfo.alternateScreen
          ? hasRenderableTerminalContent(normal)
            ? normal
            : alternate
          : normal || alternate;
      } else {
        history = await capture(false);
      }
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) return null;
      throw error;
    }

    return {
      data: appendCursorRestore(history, screenInfo),
      alternateScreen: screenInfo.alternateScreen,
      modes: encodePaneModes(screenInfo.modes),
    };
  }

  async ensureSession(): Promise<{ created: boolean }> {
    const exists = await this.host.runTmuxAllowFailure([
      'has-session',
      '-t',
      this.host.sessionName,
    ]);
    if (exists.exitCode === 0) {
      return { created: false };
    }

    await this.runTmux([
      'new-session',
      '-d',
      '-c',
      this.host.resolveDefaultWorkingDir(),
      '-s',
      this.host.sessionName,
    ]);
    return { created: true };
  }

  async configureSessionOptions(): Promise<void> {
    await this.configureSessionFlags();
    await this.configureTermEnvironment();
    await this.host.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.host.sessionName,
      'default-path',
      this.host.resolveDefaultWorkingDir(),
    ]);
    await this.host.configureWindowStyle();
  }

  async configureWindowStyleDefault(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    const windowStyle = resolveTmuxWindowStyle(styleValue);
    if (!windowStyle) {
      return;
    }
    await this.host.runTmuxAllowFailure([
      'set-hook',
      '-t',
      this.host.sessionName,
      'after-new-window',
      `set-option -w window-style '${windowStyle}'`,
    ]);
    const windows = await this.host.runTmuxAllowFailure([
      'list-windows',
      '-t',
      this.host.sessionName,
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
      await this.host.runTmuxAllowFailure([
        'set-option',
        '-w',
        '-t',
        windowId,
        'window-style',
        windowStyle,
      ]);
    }
  }

  async createParkingWindow(): Promise<string | null> {
    return createParkingWindow(this.host);
  }

  async removeParkingWindow(windowId: string | null): Promise<void> {
    return removeParkingWindow(this.host, windowId);
  }

  async runAndRefresh(argv: string[], allowTargetMissing = false): Promise<void> {
    await this.runTmux(argv, allowTargetMissing);
    await this.host.requestSnapshotInternal();
  }

  async closeWindowInternal(windowId: string): Promise<void> {
    const count = Number.parseInt(
      (
        await this.runTmux([
          'display-message',
          '-p',
          '-t',
          this.host.sessionName,
          '#{session_windows}',
        ])
      ).stdout.trim() || '0',
      10
    );

    if (count <= 1) {
      await this.runTmux([
        'new-window',
        '-d',
        '-t',
        this.host.sessionName,
        '-c',
        this.host.resolveDefaultWorkingDir(),
      ]);
    }

    logTmuxDestroy(this.host, 'kill-window', windowId);
    await this.runAndRefresh(['kill-window', '-t', windowId], true);
  }

  async resizePaneInternal(paneId: string, cols: number, rows: number): Promise<void> {
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

  async resizeWindowInternal(
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
      await this.host.requestSnapshotInternal();
    }
  }

  async resizePaneByIdInternal(
    paneId: string,
    size: { cols?: number; rows?: number }
  ): Promise<void> {
    const argv = buildResizePaneByIdArgv(paneId, size);
    if (!argv) {
      return;
    }
    await this.runTmux(argv, true);
    await this.host.requestSnapshotInternal();
  }

  async splitPaneInternal(paneId: string, direction: 'h' | 'v', cwd?: string): Promise<void> {
    const result = await this.runTmux(
      buildSplitPaneArgv(paneId, direction, cwd ?? this.host.resolveDefaultWorkingDir()),
      true
    );
    this.noteCreatedPane(result.stdout);
    await this.host.requestSnapshotInternal();
  }

  async focusPaneInternal(windowId: string, paneId: string): Promise<void> {
    this.host.activeWindowId = windowId;
    this.host.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    this.host.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
    await this.host.requestSnapshotInternal();
  }

  async selectPaneInternal(
    windowId: string,
    paneId: string,
    size: { cols: number; rows: number } | null
  ): Promise<void> {
    this.host.activeWindowId = windowId;
    this.host.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    if (size) {
      await this.resizePaneInternal(paneId, size.cols, size.rows);
    }

    this.host.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
    await this.capturePaneHistory(paneId);
    await this.host.requestSnapshotInternal();
  }

  async breakPaneInternal(paneId: string): Promise<void> {
    const result = await this.runTmux(buildBreakPaneArgv(paneId, this.host.sessionName), true);
    this.noteCreatedPane(result.stdout);
    await this.host.requestSnapshotInternal();
  }

  async capturePaneHistory(paneId: string): Promise<void> {
    const captured = await this.fetchPaneHistory(paneId);
    if (captured) {
      this.host.callbacks.onTerminalHistory(
        paneId,
        captured.data,
        captured.alternateScreen,
        captured.modes
      );
    }
  }

  async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false,
    timeoutMs = 10_000
  ): Promise<CommandResult> {
    const result = await this.host.runTmuxAllowFailure(argv, timeoutMs);
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
      `${this.host.logPrefix} tmux command failed deviceId=${this.host.deviceId} sessionName=${this.host.sessionName} argv=${argv.join(' ')} exitCode=${result.exitCode}: ${message}`
    );
    this.host.reportTmuxCommandFailure(message);
    if (this.host.connected && !this.host.manualDisconnect && isTmuxServerGoneMessage(message)) {
      console.warn(`${this.host.logPrefix} tmux server gone on ${this.host.deviceId}: ${message}`);
      this.host.onTmuxServerGone(message);
      this.host.notifySessionClosed(message);
      void this.host.shutdownInternal(true);
    }
    throw new Error(message);
  }

  recoverFromTargetMissingError(message: string): void {
    const normalized = message.toLowerCase();
    if (normalized.includes('window')) {
      this.host.activeWindowId = null;
    }
    if (normalized.includes('pane')) {
      this.host.activePaneId = null;
    }
    this.host.requestSnapshot();
  }

  findPaneWindowId(paneId: string): string | null {
    for (const window of this.host.snapshotWindows.values()) {
      if (window.panes.some((pane) => pane.id === paneId)) {
        return window.id;
      }
    }
    return null;
  }

  private fire(op: () => Promise<void>): void {
    if (!this.host.connected) {
      return;
    }
    void op().catch((error) => {
      this.host.callbacks.onError(error);
    });
  }

  private noteCreatedPane(stdout: string): void {
    const [windowId, newPaneId] = stdout.trim().split(SNAPSHOT_FIELD_SEPARATOR);
    if (isTmuxWindowId(windowId) && isTmuxPaneId(newPaneId)) {
      this.host.activeWindowId = windowId;
      this.host.activePaneId = newPaneId;
      this.host.callbacks.onEvent({
        type: 'pane-active',
        data: { windowId, paneId: newPaneId },
      });
    }
  }

  private async configureSessionFlags(): Promise<void> {
    const session = this.host.sessionName;
    await this.host.runTmuxAllowFailure([
      'set-option',
      '-t',
      session,
      '-s',
      'allow-passthrough',
      config.tmuxAllowPassthrough ? 'on' : 'off',
    ]);
    await this.host.runTmuxAllowFailure(['set-option', '-t', session, '-g', 'extended-keys', 'on']);
    await this.host.runTmuxAllowFailure([
      'set-option',
      '-t',
      session,
      '-s',
      'extended-keys-format',
      'csi-u',
    ]);
    // control client 自带 attached+focused 标志，focus-events on 会把 ESC[I 投递给
    // ?1004h 的 pane（如 Claude Code），使其永久判定「用户在场」、通知静默，必须关闭。
    await this.host.runTmuxAllowFailure(['set-option', '-t', session, '-g', 'focus-events', 'off']);
    await this.host.runTmuxAllowFailure(['set-option', '-t', session, 'destroy-unattached', 'off']);
  }

  private async configureTermEnvironment(): Promise<void> {
    const session = this.host.sessionName;
    const termProgram = config.tmuxTermProgram.trim();
    if (termProgram && termProgram.toLowerCase() !== 'off') {
      await this.host.runTmuxAllowFailure([
        'set-environment',
        '-t',
        session,
        'TERM_PROGRAM',
        termProgram,
      ]);
      if (termProgram === 'ghostty' && (await this.host.shouldInstallGhosttyTerminfo())) {
        await this.host.runTmuxAllowFailure([
          'set-option',
          '-t',
          session,
          'default-terminal',
          'xterm-ghostty',
        ]);
      }
    }

    await this.host.runTmuxAllowFailure([
      'set-environment',
      '-t',
      session,
      'COLORTERM',
      'truecolor',
    ]);
  }
}

function parseAlternateOnFlag(raw: string): boolean | null {
  const flag = raw.trim().split(/\s+/)[0];
  if (flag === '1') return true;
  if (flag === '0') return false;
  return null;
}

function buildLegacyHistoryCaptureArgv(paneId: string, alternate: boolean): string[] {
  const argv = ['capture-pane', '-t', paneId];
  if (alternate) argv.push('-a');
  argv.push('-S', `-${MAX_PANE_HISTORY_LINES}`, '-E', '-', '-e', '-J', '-N', '-p');
  if (alternate) argv.push('-q');
  return argv;
}
