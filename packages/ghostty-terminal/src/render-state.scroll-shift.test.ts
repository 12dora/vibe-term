import { describe, expect, test } from 'bun:test';
import { getGhosttyBindings } from './ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import { TEST_THEME } from './test-support/fake-dom';

const COLS = 32;
const ROWS = 6;

async function createHarness() {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(COLS, ROWS, 300);
  const renderState = createRenderState(bindings);

  for (let index = 0; index < 80; index += 1) {
    bindings.writeVt(terminal, `line-${index.toString().padStart(2, '0')} payload\r\n`);
  }

  const frame = (scrollDelta = 0) => {
    updateRenderState(renderState, terminal);
    const rows = Array.from(iterateRows(renderState, scrollDelta));
    return {
      rows,
      meta: readRenderSnapshotMeta(renderState),
      offset: bindings.readScrollbar(terminal).offset,
      appliedScrollDelta: renderState.appliedScrollDelta,
    };
  };

  return {
    bindings,
    terminal,
    renderState,
    frame,
    dispose: () => {
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

describe('render-state scroll row shifting', () => {
  test('scrolling by ±1 reuses the exact shifted rows and matches the real scrollbar delta', async () => {
    const harness = await createHarness();
    try {
      const before = harness.frame();
      expect(harness.frame().meta.dirty).toBe('clean');

      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      const upwardOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const upwardDelta = upwardOffset - before.offset;
      const upward = harness.frame(upwardDelta);

      expect(upwardDelta).toBe(-1);
      expect(upward.appliedScrollDelta).toBe(upwardDelta);
      expect(upward.meta.dirty).toBe('partial');
      expect(upward.rows.filter((row) => row.dirty)).toHaveLength(1);
      for (let row = 1; row < ROWS; row += 1) {
        expect(upward.rows[row].text).toBe(before.rows[row - 1].text);
        expect(upward.rows[row].cells).toBe(before.rows[row - 1].cells);
        expect(upward.rows[row].y).toBe(row);
      }

      harness.bindings.scrollViewportDelta(harness.terminal, 1);
      const downwardOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const downwardDelta = downwardOffset - upward.offset;
      const downward = harness.frame(downwardDelta);

      expect(downwardDelta).toBe(1);
      expect(downward.appliedScrollDelta).toBe(downwardDelta);
      expect(downward.meta.dirty).toBe('partial');
      expect(downward.rows.filter((row) => row.dirty)).toHaveLength(1);
      for (let row = 0; row < ROWS - 1; row += 1) {
        expect(downward.rows[row].text).toBe(upward.rows[row + 1].text);
        expect(downward.rows[row].cells).toBe(upward.rows[row + 1].cells);
        expect(downward.rows[row].y).toBe(row);
      }

      expect(harness.frame().meta.dirty).toBe('clean');
    } finally {
      harness.dispose();
    }
  });

  test('a clamped scroll uses the actual offset delta and does not invent a row shift', async () => {
    const harness = await createHarness();
    try {
      harness.frame();
      harness.bindings.scrollViewportBottom(harness.terminal);
      harness.frame();
      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      const nearBottom = harness.frame(-1);

      harness.bindings.scrollViewportDelta(harness.terminal, 3);
      const clampedOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const actualDelta = clampedOffset - nearBottom.offset;
      const clamped = harness.frame(actualDelta);

      expect(actualDelta).toBe(1);
      expect(clamped.appliedScrollDelta).toBe(1);
      expect(clamped.rows.filter((row) => row.dirty)).toHaveLength(1);

      harness.bindings.scrollViewportDelta(harness.terminal, 1);
      const pinnedOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const pinnedDelta = pinnedOffset - clamped.offset;
      const pinned = harness.frame(pinnedDelta);
      expect(pinnedDelta).toBe(0);
      expect(pinned.appliedScrollDelta).toBe(0);
      expect(pinned.meta.dirty).toBe('clean');
    } finally {
      harness.dispose();
    }
  });

  test('soft-wrapped rows retain wrap metadata while shifting', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(
        harness.terminal,
        `\r\n${'soft-wrap-content-'.repeat(12)}\r\ntrailer\r\n`
      );
      const before = harness.frame();
      expect(before.rows.some((row) => row.wrap || row.wrapContinuation)).toBeTrue();
      harness.frame();

      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      const offset = harness.bindings.readScrollbar(harness.terminal).offset;
      const shifted = harness.frame(offset - before.offset);

      expect(shifted.appliedScrollDelta).toBe(-1);
      for (let row = 1; row < ROWS; row += 1) {
        expect({
          text: shifted.rows[row].text,
          wrap: shifted.rows[row].wrap,
          wrapContinuation: shifted.rows[row].wrapContinuation,
        }).toEqual({
          text: before.rows[row - 1].text,
          wrap: before.rows[row - 1].wrap,
          wrapContinuation: before.rows[row - 1].wrapContinuation,
        });
      }
    } finally {
      harness.dispose();
    }
  });

  test('output and resize guards retain the full comparison path', async () => {
    const harness = await createHarness();
    try {
      const before = harness.frame();

      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      harness.bindings.writeVt(harness.terminal, '\x1b[1;1Hchanged-after-scroll');
      const outputFrame = harness.frame(0);
      expect(outputFrame.appliedScrollDelta).toBe(0);
      expect(outputFrame.meta.dirty).toBe('full');
      expect(outputFrame.rows.every((row) => row.dirty)).toBeTrue();

      const beforeResizeOffset = outputFrame.offset;
      harness.bindings.resizeTerminal(harness.terminal, 20, ROWS, { width: 8, height: 16 });
      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      const resizedOffset = harness.bindings.readScrollbar(harness.terminal).offset;
      const resized = harness.frame(resizedOffset - beforeResizeOffset);
      expect(resized.appliedScrollDelta).toBe(0);
      expect(resized.meta.cols).toBe(20);
      expect(resized.meta.dirty).toBe('full');

      expect(before.rows).toHaveLength(ROWS);
    } finally {
      harness.dispose();
    }
  });

  test('a palette change disables shifted row reuse', async () => {
    const harness = await createHarness();
    try {
      const before = harness.frame();
      harness.bindings.scrollViewportDelta(harness.terminal, -1);
      harness.bindings.setTerminalTheme(harness.terminal, {
        ...TEST_THEME,
        foreground: '#fefefe',
      });
      const offset = harness.bindings.readScrollbar(harness.terminal).offset;
      const themed = harness.frame(offset - before.offset);

      expect(themed.appliedScrollDelta).toBe(0);
      expect(themed.meta.dirty).toBe('full');
      expect(themed.rows.every((row) => row.dirty)).toBeTrue();
    } finally {
      harness.dispose();
    }
  });
});
