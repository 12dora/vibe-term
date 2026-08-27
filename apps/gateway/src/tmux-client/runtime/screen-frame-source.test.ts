import { describe, expect, test } from 'bun:test';

import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCaptureInfo } from '../pane-history-reader';
import type { PaneTerminalCursor } from '../pane-retention';
import { type ScreenFrameCaptureHost, capturePaneFrame } from './screen-frame-source';

const EPOCH = new Uint8Array(16).fill(1);
const CURSOR: PaneTerminalCursor = { paneEpoch: EPOCH, terminalSeq: 10n };

const BARRIER_FRAME: AtomicPaneCapture = {
  text: 'visible',
  historyText: 'scrollback',
  cols: 80,
  rows: 24,
  cursorX: 1,
  cursorY: 2,
  alternateScreen: false,
  historySize: 10,
  modes: null,
};

function paneInfo(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    cols: 80,
    rows: 24,
    cursorX: 0,
    cursorY: 0,
    alternateScreen: false,
    currentCommand: null,
    ...overrides,
  };
}

function fallbackHost(
  overrides: Partial<ScreenFrameCaptureHost> = {}
): ScreenFrameCaptureHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getLatestCursor: () => {
      calls.push('getLatestCursor');
      return CURSOR;
    },
    getPaneInfo: async () => {
      calls.push('getPaneInfo');
      return paneInfo();
    },
    capturePaneText: async (_paneId, opts) => {
      calls.push(`capturePaneText:${opts?.historyLines ?? 'none'}`);
      return 'hello';
    },
    getPaneHistoryCaptureInfo: async (): Promise<PaneHistoryCaptureInfo> => {
      calls.push('getPaneHistoryCaptureInfo');
      return { historySize: 7, cols: 80 };
    },
    ...overrides,
  };
}

describe('capturePaneFrame', () => {
  test('uses the barrier path and samples the cursor inside onBarrier', async () => {
    let sampledDuringBarrier = false;
    const host = fallbackHost({
      capturePaneFrameAtBarrier: async (paneId, historyLines, onBarrier) => {
        expect(paneId).toBe('%1');
        expect(historyLines).toBe(12);
        onBarrier();
        sampledDuringBarrier = true;
        return BARRIER_FRAME;
      },
    });
    const result = await capturePaneFrame(host, '%1', 12);
    expect(sampledDuringBarrier).toBe(true);
    expect(result.frame).toBe(BARRIER_FRAME);
    expect(result.baseCursor).toEqual(CURSOR);
    expect(host.calls).toEqual(['getLatestCursor']);
  });

  test('falls back to pane info and text when no barrier capture exists', async () => {
    const host = fallbackHost();
    const result = await capturePaneFrame(host, '%1', 12);
    expect(result.baseCursor).toEqual(CURSOR);
    expect(result.frame).toEqual({
      text: 'hello',
      historyText: null,
      cols: 80,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      alternateScreen: false,
      historySize: 7,
      modes: null,
    });
    expect(host.calls).toEqual([
      'getPaneInfo',
      'capturePaneText:12',
      'getLatestCursor',
      'getPaneHistoryCaptureInfo',
    ]);
  });

  test('requests no history lines on the fallback path when the pane is on the alt screen', async () => {
    const host = fallbackHost({
      getPaneInfo: async () => paneInfo({ alternateScreen: true, cursorX: 3, cursorY: 4 }),
    });
    const result = await capturePaneFrame(host, '%1', 12);
    expect(result.frame.alternateScreen).toBe(true);
    expect(result.frame.historyText).toBeNull();
    expect(host.calls).toContain('capturePaneText:0');
  });
});
