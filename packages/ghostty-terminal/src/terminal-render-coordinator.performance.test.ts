import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CanvasRendererFrame } from './canvas-renderer';
import { getGhosttyBindings } from './ghostty-wasm';
import { createRenderState, disposeRenderStateResources } from './render-state';
import { type SelectionLineModel, serializeSelectionText } from './selection-model';
import type { LinkUnderlineSegment } from './terminal-links';
import { type RenderSnapshot, TerminalRenderCoordinator } from './terminal-render-coordinator';
import type { GhosttySelectionRect } from './types';

const COLS = 32;
const ROWS = 6;

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;

beforeEach(() => {
  previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
});

async function createHarness(
  options: {
    cols?: number;
    rows?: number;
    scrollback?: number;
    lineCount?: number;
    data?: string;
  } = {}
) {
  const cols = options.cols ?? COLS;
  const rows = options.rows ?? ROWS;
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(cols, rows, options.scrollback ?? 300);
  const renderState = createRenderState(bindings);
  const frames: CanvasRendererFrame[] = [];
  const linkUnderlines: LinkUnderlineSegment[][] = [];
  const snapshots: RenderSnapshot[] = [];
  let selectionText: string | null = null;
  let selectionRects: GhosttySelectionRect[] = [];

  if (options.data !== undefined) {
    bindings.writeVt(terminal, options.data);
  } else {
    for (let index = 0; index < (options.lineCount ?? 80); index += 1) {
      bindings.writeVt(terminal, `line-${index.toString().padStart(2, '0')}\r\n`);
    }
  }

  const coordinator = new TerminalRenderCoordinator(bindings, terminal, renderState, {
    cellDimensions: () => ({ width: 8, height: 16 }),
    screenBounds: () => ({ left: 0, top: 0 }),
    viewportCols: () => cols,
    viewportRows: () => rows,
    selectionRects: () => selectionRects,
    selectionText: () => selectionText,
    selectionColor: () => 'rgba(80,80,80,0.4)',
    fileLinkContext: () => null,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onSelectionText: () => {},
  });
  coordinator.attach({
    kind: 'fake',
    render: (frame: CanvasRendererFrame) => frames.push(frame),
    drawSelectionOnly: () => {},
    drawLinkUnderlines: (segments: LinkUnderlineSegment[]) => linkUnderlines.push(segments),
    clearLinkUnderlines: () => {},
    commitCursor: () => {},
    dispose: () => {},
  } as unknown as Parameters<TerminalRenderCoordinator['attach']>[0]);

  return {
    bindings,
    terminal,
    renderState,
    coordinator,
    frames,
    linkUnderlines,
    snapshots,
    setSelection: (text: string | null, rects: GhosttySelectionRect[] = []) => {
      selectionText = text;
      selectionRects = rects;
    },
    dispose: () => {
      coordinator.cancelPending();
      coordinator.cancelLinkOverlay();
      coordinator.dispose();
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

describe('TerminalRenderCoordinator performance guards', () => {
  test('suspension suppresses every paint task and resumes with current output and geometry', async () => {
    const harness = await createHarness();
    try {
      harness.coordinator.renderNow();
      harness.setSelection('picked', [{ row: 0, x: 1, width: 2 }]);
      const framesBeforeSuspend = harness.frames.length;
      const snapshotsBeforeSuspend = harness.snapshots.length;

      harness.coordinator.setRenderSuspended(true);
      harness.bindings.resizeTerminal(harness.terminal, COLS + 8, ROWS + 2, {
        width: 8,
        height: 16,
      });
      harness.coordinator.invalidateLines();
      harness.bindings.writeVt(harness.terminal, '\x1b[2J\x1b[Hresume-output');
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.scheduleSelectionRepaint();
      harness.coordinator.scheduleLinkOverlayUpdate();
      harness.coordinator.renderNow();

      const pending = harness.coordinator as unknown as {
        loop: { frame: number | null };
        selectionFrame: number | null;
        cursorSettleFrame: number | null;
        linkOverlayTask: { timer: ReturnType<typeof setTimeout> | null };
      };
      expect(harness.frames).toHaveLength(framesBeforeSuspend);
      expect(harness.snapshots).toHaveLength(snapshotsBeforeSuspend);
      expect(pending.loop.frame).toBeNull();
      expect(pending.selectionFrame).toBeNull();
      expect(pending.cursorSettleFrame).toBeNull();
      expect(pending.linkOverlayTask.timer).toBeNull();

      harness.coordinator.setRenderSuspended(false);

      const frame = harness.frames.at(-1);
      const snapshot = harness.snapshots.at(-1);
      expect(harness.frames).toHaveLength(framesBeforeSuspend + 1);
      expect(frame?.forceFull).toBe(true);
      expect(frame?.meta.cols).toBe(COLS + 8);
      expect(frame?.meta.rows).toBe(ROWS + 2);
      expect(frame?.selectionRects).toEqual([{ row: 0, x: 1, width: 2 }]);
      expect(snapshot?.visibleLines.join('\n')).toContain('resume-output');
    } finally {
      harness.dispose();
    }
  });

  test('suspension preserves the viewport offset until the forced resume paint', async () => {
    const harness = await createHarness();
    try {
      harness.coordinator.renderNow();
      harness.coordinator.setRenderSuspended(true);
      harness.bindings.scrollViewportDelta(harness.terminal, -2);
      const expectedOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const framesBeforeResume = harness.frames.length;

      harness.coordinator.schedule();
      harness.coordinator.renderNow();
      expect(harness.frames).toHaveLength(framesBeforeResume);

      harness.coordinator.setRenderSuspended(false);

      expect(harness.frames).toHaveLength(framesBeforeResume + 1);
      expect(harness.frames.at(-1)?.forceFull).toBe(true);
      expect(harness.snapshots.at(-1)?.scrollbar.offset).toBe(expectedOffset);
    } finally {
      harness.dispose();
    }
  });

  test('scroll interleaved with output does not use shifted row reuse', async () => {
    const harness = await createHarness();
    try {
      harness.coordinator.renderNow();
      harness.coordinator.renderNow();

      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      harness.coordinator.renderNow();
      expect(harness.frames.at(-1)?.scrollDelta).toBe(-1);

      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      harness.bindings.writeVt(harness.terminal, '\x1b[1;1Houtput');
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();

      expect(harness.frames.at(-1)?.scrollDelta).toBe(0);
      expect(harness.renderState.appliedScrollDelta).toBe(0);

      harness.coordinator.invalidateLines();
      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      harness.coordinator.renderNow();
      expect(harness.frames.at(-1)?.scrollDelta).toBe(0);
      expect(harness.renderState.appliedScrollDelta).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  test('line models are lazy and the absolute-row cache is a bounded LRU', async () => {
    const harness = await createHarness();
    try {
      harness.coordinator.renderNow();
      const probe = harness.coordinator as unknown as {
        lineCache: Map<number, SelectionLineModel>;
        lineCacheLimit: number;
        cacheLineModel(line: number, model: SelectionLineModel): SelectionLineModel;
      };

      expect(probe.lineCache.size).toBe(0);
      const offset = harness.bindings.readScrollbar(harness.terminal).offset;
      expect(harness.coordinator.getLineModel(offset).colChars.length).toBe(COLS);
      expect(probe.lineCache.size).toBe(1);

      harness.setSelection('selected', [{ row: 0, x: 0, width: 1 }]);
      harness.coordinator.renderNow();
      expect(probe.lineCache.size).toBeGreaterThanOrEqual(ROWS);
      expect(probe.lineCacheLimit).toBe(2000);

      harness.bindings.writeVt(harness.terminal, '\x1b[1;1HZ');
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();
      expect(harness.coordinator.getLineModel(offset).colChars[0]).toBe('Z');

      const model: SelectionLineModel = {
        colChars: ['x'],
        contentCols: 1,
        wrappedToNext: false,
      };
      for (let line = 0; line < 2005; line += 1) {
        probe.cacheLineModel(line, model);
      }
      expect(probe.lineCache.size).toBe(2000);
      expect(probe.lineCache.has(0)).toBeFalse();
      expect(probe.lineCache.has(5)).toBeTrue();

      harness.coordinator.getLineModel(5);
      probe.cacheLineModel(2005, model);
      expect(probe.lineCache.has(5)).toBeTrue();
      expect(probe.lineCache.has(6)).toBeFalse();

      harness.bindings.resizeTerminal(harness.terminal, COLS, 101, { width: 8, height: 16 });
      harness.coordinator.invalidateLines();
      harness.coordinator.renderNow();
      expect(probe.lineCacheLimit).toBe(2020);
      expect(probe.lineCache.size).toBeLessThanOrEqual(2020);
    } finally {
      harness.dispose();
    }
  });

  test('an active selection retains more than 2000 absolute rows and trims after it ends', async () => {
    const harness = await createHarness({ lineCount: 2100, scrollback: 3000 });
    try {
      harness.setSelection('selected', [{ row: 0, x: 0, width: 1 }]);
      harness.coordinator.renderNow();

      const probe = harness.coordinator as unknown as {
        lineCache: Map<number, SelectionLineModel>;
        lineCacheLimit: number;
        cacheLineModel(line: number, model: SelectionLineModel): SelectionLineModel;
      };
      const total = harness.bindings.readScrollbar(harness.terminal).total;
      expect(total).toBeGreaterThan(2000);
      expect(probe.lineCacheLimit).toBe(total);

      const model: SelectionLineModel = {
        colChars: ['x'],
        contentCols: 1,
        wrappedToNext: false,
      };
      for (let line = 0; line < total; line += 1) {
        probe.cacheLineModel(line, model);
      }

      expect(probe.lineCache.size).toBe(total);
      expect(probe.lineCache.has(0)).toBeTrue();
      const copied = serializeSelectionText(
        {
          anchor: { line: 0, col: 0 },
          focus: { line: total - 1, col: 0 },
          mode: 'character',
        },
        (line) => harness.coordinator.getLineModel(line)
      );
      expect(copied?.startsWith('x\n')).toBeTrue();

      harness.setSelection(null);
      harness.coordinator.renderNow();
      expect(probe.lineCacheLimit).toBe(2000);
      expect(probe.lineCache.size).toBe(2000);
    } finally {
      harness.dispose();
    }
  });

  test('link overlay caches the preceding row for a wrapped URL crossing the viewport top', async () => {
    const harness = await createHarness({
      cols: 10,
      rows: 3,
      scrollback: 50,
      data: 'https://example.com\r\nA\r\nB\r\nC\r\n',
    });
    try {
      const probe = harness.coordinator as unknown as {
        updateLinkOverlay(): void;
      };

      harness.bindings.scrollViewportTop(harness.terminal);
      harness.coordinator.renderNow();
      probe.updateLinkOverlay();

      harness.bindings.scrollViewportDelta(harness.terminal, 1);
      harness.coordinator.renderNow();
      probe.updateLinkOverlay();

      expect(harness.coordinator.linkAt(8, 8)).toEqual({
        kind: 'url',
        url: 'https://example.com',
      });
      expect(harness.linkUnderlines.at(-1)).toContainEqual({ row: 0, startCol: 0, endCol: 8 });
    } finally {
      harness.dispose();
    }
  });
});
