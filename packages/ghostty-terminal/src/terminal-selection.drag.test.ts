// 选区拖拽路径：mousemove 不再同步跑全渲染。同 cell 的移动直接丢弃，跨 cell 的移动
// 只排一帧「选区层重绘」（复用上一次全渲染留下的行模型，不读 WASM），自动滚动 / 输出 /
// resize 仍走全渲染。
import { afterEach, describe, expect, test } from 'bun:test';
import type { GhosttyBindings } from './ghostty-wasm';
import type { GhosttyRenderStateResources } from './render-state';
import type { SelectionLineModel } from './selection-model';
import { TerminalRenderCoordinator } from './terminal-render-coordinator';
import { type SelectionHostContext, TerminalSelection } from './terminal-selection';
import { type FakeDom, installFakeDom } from './test-support/fake-dom';
import { lineModelFromText } from './test-support/selection-line-model';
import type { GhosttySelectionRect } from './types';

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;
const BOUNDS = { top: 0, bottom: 200 };

type Calls = { render: number; renderSelection: number; scroll: number[] };

function createContext(overrides: Partial<SelectionHostContext> = {}): {
  context: SelectionHostContext;
  calls: Calls;
} {
  const calls: Calls = { render: 0, renderSelection: 0, scroll: [] };
  const context: SelectionHostContext = {
    getLineModel: (line: number): SelectionLineModel => lineModelFromText(`line-${line} content`),
    hitTest: (clientX: number, clientY: number) => ({
      line: Math.floor(clientY / CELL_HEIGHT),
      col: Math.floor(clientX / CELL_WIDTH),
    }),
    getScreenBounds: () => BOUNDS,
    scrollViewportBy: (delta: number) => {
      calls.scroll.push(delta);
    },
    render: () => {
      calls.render += 1;
    },
    renderSelection: () => {
      calls.renderSelection += 1;
    },
    ...overrides,
  };

  return { context, calls };
}

describe('TerminalSelection 拖拽', () => {
  test('按下走全渲染，跨 cell 拖拽只排选区重绘', () => {
    const { context, calls } = createContext();
    const selection = new TerminalSelection(context);

    expect(selection.begin(5, 5, 'character')).toBeTrue();
    expect(calls).toMatchObject({ render: 1, renderSelection: 0 });

    selection.update(35, 5);
    selection.update(65, 5);
    expect(calls).toMatchObject({ render: 1, renderSelection: 2 });
    expect(selection.getText()).toBe('line-0 ');
  });

  test('落在同一 cell 的移动完全不重绘', () => {
    const { context, calls } = createContext();
    const selection = new TerminalSelection(context);

    selection.begin(5, 5, 'character');
    selection.update(35, 5);
    expect(calls.renderSelection).toBe(1);

    // 同一 cell 内的亚像素抖动：一律丢弃。
    selection.update(36, 6);
    selection.update(39, 9);
    expect(calls.renderSelection).toBe(1);
    expect(calls.render).toBe(1);

    // 但拖拽仍算「动过」，松手时不应被判成原地单击而清空选区。
    selection.update(45, 5);
    expect(calls.renderSelection).toBe(2);
  });

  test('同 cell 抖动仍算「拖拽过」，松手判 keep（行为与旧实现一致）', () => {
    const { context, calls } = createContext();
    const selection = new TerminalSelection(context);

    selection.begin(5, 5, 'character');
    selection.update(6, 6);
    expect(calls.renderSelection).toBe(0);
    expect(selection.finishPointerDrag({ button: 0, clientX: 6, clientY: 6 } as MouseEvent)).toBe(
      'keep'
    );
  });

  test('拖出视口的自动滚动仍走全渲染', async () => {
    const { context, calls } = createContext();
    const selection = new TerminalSelection(context);

    selection.begin(5, 5, 'character');
    selection.update(5, 400);
    const beforeTicks = calls.render;

    await new Promise((resolve) => setTimeout(resolve, 160));
    selection.endDrag();

    expect(calls.scroll.length).toBeGreaterThan(0);
    expect(calls.render).toBeGreaterThan(beforeTicks);
  });
});

describe('TerminalRenderCoordinator 选区重绘', () => {
  let dom: FakeDom | null = null;

  afterEach(() => {
    dom?.restore();
    dom = null;
  });

  function setup(): {
    fakeDom: FakeDom;
    coordinator: TerminalRenderCoordinator;
    painted: Array<{ rects: GhosttySelectionRect[]; color: string }>;
    selectionTexts: Array<string | null>;
  } {
    const fakeDom = installFakeDom();
    dom = fakeDom;
    const painted: Array<{ rects: GhosttySelectionRect[]; color: string }> = [];
    const selectionTexts: Array<string | null> = [];

    const coordinator = new TerminalRenderCoordinator(
      {} as GhosttyBindings,
      1,
      {} as GhosttyRenderStateResources,
      {
        cellDimensions: () => ({ width: CELL_WIDTH, height: CELL_HEIGHT }),
        screenBounds: () => ({ left: 0, top: 0 }),
        viewportCols: () => 80,
        viewportRows: () => 24,
        selectionRects: () => [{ row: 0, x: 1, width: 2 }],
        selectionText: () => 'picked',
        selectionColor: () => 'rgba(1,2,3,0.4)',
        fileLinkContext: () => null,
        onSnapshot: () => {},
        onSelectionText: (text) => {
          selectionTexts.push(text);
        },
      }
    );

    coordinator.attach({
      kind: 'fake',
      render: () => {},
      drawSelectionOnly: (rects: GhosttySelectionRect[], color: string) => {
        painted.push({ rects, color });
      },
      drawLinkUnderlines: () => {},
      clearLinkUnderlines: () => {},
      dispose: () => {},
    } as unknown as Parameters<TerminalRenderCoordinator['attach']>[0]);

    return { fakeDom, coordinator, painted, selectionTexts };
  }

  test('同一帧内的多次请求合并成一次选区层重绘', async () => {
    const { fakeDom, coordinator, painted, selectionTexts } = setup();

    coordinator.scheduleSelectionRepaint();
    coordinator.scheduleSelectionRepaint();
    coordinator.scheduleSelectionRepaint();
    expect(painted).toEqual([]);

    await fakeDom.flushAnimationFrames();

    expect(painted).toEqual([{ rects: [{ row: 0, x: 1, width: 2 }], color: 'rgba(1,2,3,0.4)' }]);
    // 选区文本每帧最多算一次（拖拽中不再逐次 mousemove 序列化）。
    expect(selectionTexts).toEqual(['picked']);

    coordinator.dispose();
  });

  test('cancelPending / dispose 会取消排队中的选区帧', async () => {
    const { fakeDom, coordinator, painted } = setup();

    coordinator.scheduleSelectionRepaint();
    coordinator.cancelPending();
    await fakeDom.flushAnimationFrames();
    expect(painted).toEqual([]);

    coordinator.scheduleSelectionRepaint();
    coordinator.dispose();
    await fakeDom.flushAnimationFrames();
    expect(painted).toEqual([]);
  });
});
