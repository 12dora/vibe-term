import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import { SNAPSHOT_FIELD_SEPARATOR, isTmuxPaneId, isTmuxWindowId } from '../snapshot-format';
import {
  buildBreakPaneArgv,
  buildCreateWindowArgv,
  buildMovePaneArgv,
  buildResizePaneByIdArgv,
  buildSplitPaneArgv,
} from './session-command-argv';
import type { SessionCommandHost } from './session-command-host';
import {
  recoverFromTargetMissingError as recoverFromTargetMissingErrorOnHost,
  runTmux as runTmuxOnHost,
} from './session-command-runner';
import {
  configureSessionOptions as configureSessionOptionsOnHost,
  configureWindowStyleDefault as configureWindowStyleDefaultOnHost,
  createParkingWindow as createParkingWindowOnHost,
  ensureSession as ensureSessionOnHost,
  removeParkingWindow as removeParkingWindowOnHost,
  setWindowStyle as setWindowStyleOnHost,
} from './session-lifecycle-commands';
import {
  capturePaneFrameAtBarrier as capturePaneFrameAtBarrierOnHost,
  capturePaneHistory as capturePaneHistoryOnHost,
  capturePaneHistoryRange as capturePaneHistoryRangeOnHost,
  capturePaneText as capturePaneTextOnHost,
  fetchPaneHistory as fetchPaneHistoryOnHost,
  getPaneHistoryCaptureInfo as getPaneHistoryCaptureInfoOnHost,
  getPaneInfo as getPaneInfoOnHost,
  requestPaneHistory as requestPaneHistoryOnHost,
} from './session-pane-query';
import type { CommandResult } from './types';

export type { SessionCommandHost } from './session-command-host';
export {
  buildBreakPaneArgv,
  buildCreateWindowArgv,
  buildMovePaneArgv,
  buildResizePaneByIdArgv,
  buildSplitPaneArgv,
} from './session-command-argv';

export class SessionCommands {
  private stackedLayoutTransition: Promise<void> = Promise.resolve();

  constructor(private readonly host: SessionCommandHost) {}

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
    await requestPaneHistoryOnHost(this.host, paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.fire(() => this.runAndRefresh(['rename-window', '-t', windowId, name]));
  }

  async setWindowStyle(style: string): Promise<void> {
    await setWindowStyleOnHost(this.host, style);
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    return capturePaneTextOnHost(this.host, paneId, opts);
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    return getPaneInfoOnHost(this.host, paneId);
  }

  async getPaneHistoryCaptureInfo(paneId: string) {
    return getPaneHistoryCaptureInfoOnHost(this.host, paneId);
  }

  async capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string> {
    return capturePaneHistoryRangeOnHost(this.host, paneId, startLine, endLine, maxOutputBytes);
  }

  capturePaneFrameAtBarrier(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture> {
    return capturePaneFrameAtBarrierOnHost(this.host, paneId, historyLines, onBarrier);
  }

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    return fetchPaneHistoryOnHost(this.host, paneId);
  }

  async ensureSession(): Promise<{ created: boolean }> {
    return ensureSessionOnHost(this.host);
  }

  async configureSessionOptions(): Promise<void> {
    await configureSessionOptionsOnHost(this.host);
  }

  async configureWindowStyleDefault(styleValue?: string): Promise<void> {
    await configureWindowStyleDefaultOnHost(this.host, styleValue);
  }

  async createParkingWindow(): Promise<string | null> {
    return createParkingWindowOnHost(this.host);
  }

  async removeParkingWindow(windowId: string | null): Promise<void> {
    await removeParkingWindowOnHost(this.host, windowId);
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
    await capturePaneHistoryOnHost(this.host, paneId);
    await this.host.requestSnapshotInternal();
  }

  async breakPaneInternal(paneId: string): Promise<void> {
    const result = await this.runTmux(buildBreakPaneArgv(paneId, this.host.sessionName), true);
    this.noteCreatedPane(result.stdout);
    await this.host.requestSnapshotInternal();
  }

  async capturePaneHistory(paneId: string): Promise<void> {
    await capturePaneHistoryOnHost(this.host, paneId);
  }

  async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false,
    timeoutMs = 10_000
  ): Promise<CommandResult> {
    return runTmuxOnHost(this.host, argv, allowTargetMissing, timeoutMs);
  }

  recoverFromTargetMissingError(message: string): void {
    recoverFromTargetMissingErrorOnHost(this.host, message);
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
}
