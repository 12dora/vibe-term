// 真实 wasm 下 OSC 8 链接经渲染协调器的命中与下划线：坐标落在 coordinator 的绝对行空间，
// 回滚区同样可命中；渲染之后 ghostty 视口又滚动（尚未重画）时，仍查用户看到的那一行。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GhosttyHyperlinkReader } from './ghostty-hyperlink';
import { getGhosttyBindings } from './ghostty-wasm';
import { createRenderState, disposeRenderStateResources } from './render-state';
import type { LinkViewState, TerminalLinkResolver } from './terminal-link-resolver';
import type { LinkUnderlineSegment } from './terminal-links';
import { TerminalRenderCoordinator } from './terminal-render-coordinator';
import type { GhosttyRenderRow } from './types';

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const LINKED = 'ab\x1b]8;;https://example.com/a\x1b\\label\x1b]8;;\x1b\\ z';

let previousRaf: typeof globalThis.requestAnimationFrame;
let previousCancelRaf: typeof globalThis.cancelAnimationFrame;
beforeEach(() => {
  previousRaf = globalThis.requestAnimationFrame;
  previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = previousRaf;
  globalThis.cancelAnimationFrame = previousCancelRaf;
});

async function createHarness(data: string, cols = 40, rows = 4) {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(cols, rows, 200);
  const renderState = createRenderState(bindings);
  const underlines: LinkUnderlineSegment[][] = [];
  let onSnapshot = (): void => {};
  bindings.writeVt(terminal, data);
  const coordinator = new TerminalRenderCoordinator(bindings, terminal, renderState, {
    cellDimensions: () => ({ width: CELL_WIDTH, height: CELL_HEIGHT }),
    screenBounds: () => ({ left: 0, top: 0 }),
    viewportCols: () => cols,
    viewportRows: () => rows,
    selectionRects: () => [],
    selectionText: () => null,
    selectionColor: () => 'rgba(0,0,0,0)',
    fileLinkContext: () => null,
    onSnapshot: () => onSnapshot(),
    onSelectionText: () => {},
  });
  coordinator.attach({
    kind: 'fake',
    render: () => {},
    drawSelectionOnly: () => {},
    drawLinkUnderlines: (segments: LinkUnderlineSegment[]) => underlines.push(segments),
    clearLinkUnderlines: () => {},
    commitCursor: () => {},
    dispose: () => {},
  } as unknown as Parameters<TerminalRenderCoordinator['attach']>[0]);
  const probe = coordinator as unknown as {
    updateLinkOverlay(): void;
    linkView(): LinkViewState;
    renderedRows: GhosttyRenderRow[];
    links: TerminalLinkResolver;
    linkOverlayTask: { timer: ReturnType<typeof setTimeout> | null };
  };
  const grid = (probe.links as unknown as { explicit: { grid: GhosttyHyperlinkReader } }).explicit
    .grid;
  const kernelReads = { count: 0 };
  const uriAt = grid.uriAt.bind(grid);
  const viewport = grid.viewport.bind(grid);
  grid.uriAt = (x, y) => {
    kernelReads.count += 1;
    return uriAt(x, y);
  };
  grid.viewport = () => {
    kernelReads.count += 1;
    return viewport();
  };

  return {
    bindings,
    terminal,
    coordinator,
    underlines,
    probe,
    kernelReads,
    setOnSnapshot: (callback: () => void) => {
      onSnapshot = callback;
    },
    // 换成内容相同的新 cells 数组：等价于一行从未被预热 / 缓存过。
    forgetRowCache: (index: number) => {
      const row = probe.renderedRows[index];
      probe.renderedRows[index] = { ...row, cells: [...row.cells] };
    },
    updateOverlay: () => probe.updateLinkOverlay(),
    // 模拟 terminal.write：写入内核并标记「有未渲染的输出」，但不渲染（BSU 挂起 / rAF 未到）
    writeWithoutRender: (data: string) => {
      bindings.writeVt(terminal, data);
      coordinator.noteOutput();
    },
    linkAt: (col: number, row: number) =>
      coordinator.linkAt(col * CELL_WIDTH + 1, row * CELL_HEIGHT + 1),
    dispose: () => {
      coordinator.cancelPending();
      coordinator.cancelLinkOverlay();
      coordinator.dispose();
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

const EXPECTED_HIT = {
  kind: 'url',
  url: 'https://example.com/a',
  explicit: true,
  tooltip: 'https://example.com/a',
};

describe('TerminalRenderCoordinator explicit 链接', () => {
  test('OSC 8 label 各格命中完整 URI，段外不命中，下划线覆盖 label', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      for (let col = 2; col <= 6; col += 1) {
        expect(harness.linkAt(col, 0)).toEqual(EXPECTED_HIT);
      }
      expect(harness.linkAt(1, 0)).toBeNull();
      expect(harness.linkAt(7, 0)).toBeNull();

      harness.updateOverlay();
      expect(harness.underlines.at(-1)).toEqual([{ row: 0, startCol: 2, endCol: 6 }]);
    } finally {
      harness.dispose();
    }
  });

  test('滚进回滚区后命中的是屏幕上看到的那一行', async () => {
    const filler = Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\r\n');
    const harness = await createHarness(`top\r\n${LINKED}\r\n${filler}`);
    try {
      harness.bindings.scrollViewportTop(harness.terminal);
      harness.coordinator.renderNow();
      expect(harness.linkAt(3, 1)).toEqual(EXPECTED_HIT);
      expect(harness.linkAt(3, 0)).toBeNull();

      harness.updateOverlay();
      expect(harness.underlines.at(-1)).toEqual([{ row: 1, startCol: 2, endCol: 6 }]);
    } finally {
      harness.dispose();
    }
  });

  test('渲染后 ghostty 视口又下滚一行（尚未重画）：按绝对行换算，仍命中可见的链接', async () => {
    const filler = Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\r\n');
    const harness = await createHarness(`top\r\n${LINKED}\r\n${filler}`);
    try {
      harness.bindings.scrollViewportTop(harness.terminal);
      harness.coordinator.renderNow();
      harness.bindings.scrollViewportDelta(harness.terminal, 1);

      // 屏幕仍是上一帧：链接在第 1 行；ghostty 视口里它已在 y=0。
      expect(harness.linkAt(3, 1)).toEqual(EXPECTED_HIT);
    } finally {
      harness.dispose();
    }
  });
});

// CR2 #1：内核已有未渲染的变更时不得拿旧帧的行去查内核，更不能把读到的结果缓存到旧行身份上
// ——下一帧 render-state 可能原样复用这个 cells 数组，缓存一旦毒化，链接就永久失活。
describe('内核与渲染不同步时的 explicit 缓存', () => {
  test('BSU 清屏重绘：清屏期间屏幕仍是上一帧、命中上一帧的链接，不毒化；ESU 后复用同一行身份仍可命中', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      const cellsBefore = harness.probe.renderedRows[0].cells;

      harness.writeWithoutRender('\x1b[?2026h\x1b[2J\x1b[H');
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
      harness.updateOverlay();
      expect(harness.underlines.at(-1)).toEqual([{ row: 0, startCol: 2, endCol: 6 }]);

      harness.writeWithoutRender(`${LINKED}\x1b[?2026l`);
      harness.coordinator.renderNow();
      expect(harness.probe.renderedRows[0].cells).toBe(cellsBefore);
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
      harness.updateOverlay();
      expect(harness.underlines.at(-1)).toEqual([{ row: 0, startCol: 2, endCol: 6 }]);
    } finally {
      harness.dispose();
    }
  });

  test('渲染前改写成别的链接：不同步期间仍按屏幕上的上一帧命中，渲染后读到新 URI', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      const relinked = 'ab\x1b]8;;https://other.example/b\x1b\\other\x1b]8;;\x1b\\ z';
      harness.writeWithoutRender(`\r\x1b[2K${relinked}`);
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);

      harness.coordinator.renderNow();
      expect(harness.linkAt(3, 0)).toMatchObject({ url: 'https://other.example/b' });
    } finally {
      harness.dispose();
    }
  });

  test('resize / reset 之后（invalidateLines）渲染前不读内核，并取消挂起的下划线重算', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      harness.forgetRowCache(0);
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
      expect(harness.kernelReads.count).toBeGreaterThan(0);

      harness.coordinator.scheduleLinkOverlayUpdate();
      harness.bindings.resizeTerminal(harness.terminal, 20, 2, { width: 8, height: 16 });
      harness.coordinator.invalidateLines();
      expect(harness.probe.linkOverlayTask.timer).toBeNull();

      harness.forgetRowCache(0);
      const readsBefore = harness.kernelReads.count;
      expect(harness.linkAt(3, 0)).toBeNull();
      harness.updateOverlay();
      expect(harness.kernelReads.count).toBe(readsBefore);

      harness.coordinator.renderNow();
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
    } finally {
      harness.dispose();
    }
  });

  test('有未渲染输出时，从未缓存的链接行不读内核；渲染后照常命中', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      harness.writeWithoutRender('\x1b[2;1Hspin');
      harness.forgetRowCache(0);
      const readsBefore = harness.kernelReads.count;
      harness.linkAt(3, 0);
      harness.updateOverlay();
      expect(harness.kernelReads.count).toBe(readsBefore);

      harness.coordinator.renderNow();
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
    } finally {
      harness.dispose();
    }
  });

  test('warm 在不同步时什么都不读', async () => {
    const harness = await createHarness(LINKED);
    try {
      harness.coordinator.renderNow();
      harness.forgetRowCache(0);
      const readsBefore = harness.kernelReads.count;
      harness.probe.links.warm({ ...harness.probe.linkView(), synced: false });
      expect(harness.kernelReads.count).toBe(readsBefore);
    } finally {
      harness.dispose();
    }
  });

  test('onSnapshot 回调同步改写内核不毒化缓存：应用重绘回原行（复用同一 cells）仍命中原 URI', async () => {
    const harness = await createHarness(LINKED);
    try {
      const relinked = 'ab\x1b]8;;https://wrong-b.example\x1b\\other\x1b]8;;\x1b\\ z';
      harness.setOnSnapshot(() => {
        harness.setOnSnapshot(() => {});
        harness.writeWithoutRender(`\r\x1b[2K${relinked}`);
      });
      harness.coordinator.renderNow();
      const cellsA = harness.probe.renderedRows[0].cells;
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);

      harness.writeWithoutRender(`\r\x1b[2K${LINKED}`);
      harness.coordinator.renderNow();
      expect(harness.probe.renderedRows[0].cells).toBe(cellsA);
      expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
    } finally {
      harness.dispose();
    }
  });

  test('dispose 取消挂起的下划线重算', async () => {
    const harness = await createHarness(LINKED);
    harness.coordinator.renderNow();
    harness.coordinator.scheduleLinkOverlayUpdate();
    harness.coordinator.dispose();
    expect(harness.probe.linkOverlayTask.timer).toBeNull();
    harness.dispose();
  });
});

// CR2 #5：宽字符放不下被折到下一行时，行尾留下带 hyperlink 标记的 spacer-head 空占位。
describe('渲染末尾预热 explicit 缓存', () => {
  test('持续输出（每次查询都不同步）时，已渲染过的链接行仍可命中、有下划线', async () => {
    const harness = await createHarness(`${LINKED}\r\nspin`);
    try {
      harness.coordinator.renderNow();
      for (const frame of ['|', '/', '-']) {
        harness.writeWithoutRender(`\x1b[2;1H\x1b[2Kspin ${frame}`);
        expect(harness.linkAt(3, 0)).toEqual(EXPECTED_HIT);
        harness.updateOverlay();
        expect(harness.underlines.at(-1)).toEqual([{ row: 0, startCol: 2, endCol: 6 }]);
        harness.coordinator.renderNow();
      }
    } finally {
      harness.dispose();
    }
  });
});

describe('行尾 spacer-head', () => {
  test('不画孤立下划线、不可点击；折到下一行的链接正常', async () => {
    const harness = await createHarness(
      'abcd\x1b]8;;https://wrap.example\x1b\\界x\x1b]8;;\x1b\\',
      5,
      4
    );
    try {
      harness.coordinator.renderNow();
      expect(harness.probe.renderedRows[0].cells[4]).toMatchObject({
        widthKind: 'spacer-head',
        hasHyperlink: true,
      });
      expect(harness.linkAt(4, 0)).toBeNull();
      expect(harness.linkAt(0, 1)).toMatchObject({ url: 'https://wrap.example', explicit: true });
      harness.updateOverlay();
      expect(harness.underlines.at(-1)).toEqual([{ row: 1, startCol: 0, endCol: 2 }]);
    } finally {
      harness.dispose();
    }
  });
});
