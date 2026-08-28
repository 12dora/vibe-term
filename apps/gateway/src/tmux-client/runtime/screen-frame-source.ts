import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCaptureInfo } from '../pane-history-reader';
import type { PaneTerminalCursor } from '../pane-retention';

export interface ScreenFrameCaptureHost {
  capturePaneFrameAtBarrier?(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
  getLatestCursor(paneId: string): PaneTerminalCursor | null;
}

export interface CapturedPaneFrame {
  frame: AtomicPaneCapture;
  baseCursor: PaneTerminalCursor | null;
}

export async function capturePaneFrame(
  host: ScreenFrameCaptureHost,
  paneId: string,
  historyLines: number
): Promise<CapturedPaneFrame> {
  const captureAtBarrier = host.capturePaneFrameAtBarrier;
  if (captureAtBarrier) {
    let baseCursor: PaneTerminalCursor | null = null;
    const frame = await captureAtBarrier(paneId, historyLines, () => {
      baseCursor = host.getLatestCursor(paneId);
    });
    return { frame, baseCursor };
  }
  return captureFallback(host, paneId, historyLines);
}

async function captureFallback(
  host: ScreenFrameCaptureHost,
  paneId: string,
  historyLines: number
): Promise<CapturedPaneFrame> {
  const info = await host.getPaneInfo(paneId);
  const text = await host.capturePaneText(paneId, {
    historyLines: info.alternateScreen ? 0 : historyLines,
  });
  const baseCursor = host.getLatestCursor(paneId);
  const frame: AtomicPaneCapture = {
    text,
    historyText: null,
    cols: info.cols,
    rows: info.rows,
    cursorX: info.cursorX,
    cursorY: info.cursorY,
    alternateScreen: info.alternateScreen,
    historySize: (await host.getPaneHistoryCaptureInfo(paneId)).historySize,
    modes: null,
  };
  return { frame, baseCursor };
}
