import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type FakeBindings,
  type FakeCanvasElement,
  type FakeDom,
  type FakeElement,
  TEST_THEME,
  createFakeBindings,
  disposeTrackedTerminals,
  findCanvasByLayer,
  findHelperTextarea,
  installFakeDom,
  mockGhosttyWasm,
  restoreRealTerminalModules,
  trackTerminal,
} from './test-support/fake-dom';
import type { GhosttyTerminalInitOptions } from './types';

// 跨 bug 干扰测试（issue #45 Task 12 场景 1）：bug 3（forceFullRepaint）× bug 4-C
// （syncTextareaPositionToCursor 改读 lastCursor 不消费 dirty）协同。
//
// Metis 担心：forceFullRepaint 标记被 IME composition 提前进 syncTextareaPositionToCursor
// 的路径消耗或污染，导致 forceFull 用了过时的 lastCursor / IME 位置错位。
//
// 验证点：
//   1. forceFullRepaint 标记在下一帧 render 一次性传给 renderer（forceFull=true），
//      即使 ghostty 报 dirty='clean' 也强制全画；下一帧无 forceFull 标记 → dirty='clean'
//      正常早退（一次性消费，不污染后续帧）。
//   2. forceFullRepaint 标记后触发 IME composition 事件，syncTextareaPositionToCursor
//      仍走 bug 4-C 路径（读 lastCursor，不调 updateRenderState 消费 dirty）；
//      flush rAF 后 forceFull render 正确执行 + lastCursor 被更新到新位置。
//
// DOM / rAF / bindings 脚手架见 test-support/fake-dom.ts。

// render-state mock 用可变状态，让单个测试能在 render 之间切换 dirty / cursor。
interface RenderStateMock {
  dirty: 'clean' | 'partial' | 'full';
  cursorX: number;
  cursorY: number;
  rowText: string;
}

interface UpdateRenderStateCall {
  snapshotVersion: number;
}

async function loadControllerModule(
  bindings: FakeBindings,
  version: number,
  state: RenderStateMock,
  updateCalls: UpdateRenderStateCall[]
) {
  mock.restore();
  mockGhosttyWasm(bindings);

  const buildRows = (rowText: string) => {
    const cells = Array.from(rowText).map((char, index) => ({
      x: index,
      text: char,
      codepoints: [char.codePointAt(0) ?? 32],
      widthKind: 'narrow' as const,
      hasText: true,
      style: {
        bold: false,
        italic: false,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
        underline: 0,
      },
      fgColor: null,
      bgColor: null,
    }));
    return [
      {
        y: 0,
        dirty: true,
        wrap: false,
        wrapContinuation: false,
        text: rowText,
        cells,
      },
    ];
  };

  mock.module('./render-state', () => ({
    createRenderState: () => ({
      snapshotVersion: 0,
      disposed: false,
      rowIteratorHandle: 7,
      rowCellsHandle: 8,
      renderStateHandle: 9,
      bindings,
      cachedMeta: null,
    }),
    updateRenderState: (s: { snapshotVersion: number }) => {
      s.snapshotVersion += 1;
      updateCalls.push({ snapshotVersion: s.snapshotVersion });
    },
    readRenderSnapshotMeta: () => ({
      cols: 80,
      rows: 24,
      dirty: state.dirty,
      colors: {
        background: { r: 17, g: 17, b: 17 },
        foreground: { r: 238, g: 238, b: 238 },
        cursor: { r: 255, g: 255, b: 255 },
        palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
      },
      cursor: {
        style: 'block' as const,
        visible: true,
        blinking: false,
        passwordInput: false,
        x: state.cursorX,
        y: state.cursorY,
        wideTail: false,
      },
    }),
    iterateRows: function* () {
      yield* buildRows(state.rowText);
    },
    disposeRenderStateResources: (s: { disposed: boolean }) => {
      s.disposed = true;
    },
  }));

  const controllerModule = await import(`./terminal.ts?issue45-crossbug-${version}`);

  return {
    ...controllerModule,
    createTerminalController: async (options: GhosttyTerminalInitOptions) =>
      trackTerminal(await controllerModule.createTerminalController(options)),
  };
}

function findMainCanvas(root: FakeElement | null): FakeCanvasElement | null {
  return findCanvasByLayer(root, 'main');
}

function countFillText(canvas: FakeCanvasElement | null): number {
  if (!canvas) return 0;
  return canvas.context.operations.filter((op) => op.type === 'fillText').length;
}

afterAll(restoreRealTerminalModules);

describe('issue45 cross-bug: bug 3 (forceFullRepaint) x bug 4-C (syncTextarea reads lastCursor)', () => {
  let dom: FakeDom | null = null;
  let importVersion = 0;

  afterEach(() => {
    disposeTrackedTerminals();
    dom?.restore();
    dom = null;
    mock.restore();
  });

  test('forceFullRepaint forces full draw even when ghostty reports dirty=clean (bug 3) and is consumed once', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const state: RenderStateMock = {
      dirty: 'full',
      cursorX: 1,
      cursorY: 0,
      rowText: 'A',
    };
    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      state,
      updateCalls
    );

    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });

    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);
    terminal.write('A');
    await dom.flushAnimationFrames();

    const mainCanvas = findMainCanvas(dom.document.body);
    expect(mainCanvas).not.toBeNull();
    if (!mainCanvas) return;
    const initialFillText = countFillText(mainCanvas);
    expect(initialFillText).toBeGreaterThan(0);

    // bug 3 触发条件：canvas 位图被 resize 清空但 ghostty 报 dirty='clean'。
    state.dirty = 'clean';
    mainCanvas.context.operations = [];

    // forceFullRepaint 同步执行 render（不等 rAF）：dirty='clean' 仍强制全画。
    terminal.forceFullRepaint();
    expect(countFillText(mainCanvas)).toBeGreaterThan(0);

    // forceFullNext 必须一次性消费：后续普通 render 在 dirty='clean' 下不再全画。
    mainCanvas.context.operations = [];
    terminal.write('B');
    await dom.flushAnimationFrames();

    expect(countFillText(mainCanvas)).toBe(0);

    terminal.dispose();
  });

  test('IME composition during pending forceFull does not consume dirty (bug 4-C) and forceFull render still fires', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const state: RenderStateMock = {
      dirty: 'full',
      cursorX: 1,
      cursorY: 0,
      rowText: 'A',
    };
    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      state,
      updateCalls
    );

    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });

    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);
    terminal.write('A');
    await dom.flushAnimationFrames();

    const textarea = findHelperTextarea(dom.document.body);
    expect(textarea).toBeDefined();
    if (!textarea) return;

    const mainCanvas = findMainCanvas(dom.document.body);
    expect(mainCanvas).not.toBeNull();
    if (!mainCanvas) return;

    // 切到 bug 3 触发态：ghostty 报 clean，但 canvas 已被 resize 清空。
    state.dirty = 'clean';
    // 同时移动光标位置——验证 forceFull render 会更新 lastCursor 到新位置。
    state.cursorX = 5;
    state.cursorY = 2;

    const leftAfterInit = textarea.style.left;

    // 同步语义：forceFullRepaint 立即执行 render（bug 3：dirty='clean' 仍全画），
    // 并把 lastCursor 更新到 (5, 2)。
    const baseline = updateCalls.length;
    mainCanvas.context.operations = [];
    terminal.forceFullRepaint();
    expect(countFillText(mainCanvas)).toBeGreaterThan(0);
    expect(updateCalls.length - baseline).toBe(1);

    textarea.dispatchEvent({ type: 'compositionstart', data: '' });
    textarea.dispatchEvent({ type: 'compositionupdate', data: '你' });

    // bug 4-C：composition 期间 syncTextareaPositionToCursor 不调 updateRenderState
    //（不消费 dirty），只读 forceFull render 缓存的 lastCursor。
    expect(updateCalls.length - baseline).toBe(1);

    // lastCursor 已更新到 (5, 2)：composition 定位用最新光标而非过时缓存。
    textarea.dispatchEvent({ type: 'compositionupdate', data: '你好' });
    expect(textarea.style.left).not.toEqual(leftAfterInit);

    terminal.dispose();
  });
});
