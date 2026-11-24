// 预测宿主的帧数据与 overlay 联动：真实 wasm + fake DOM（同 terminal.synchronized-output-scroll.test.ts）。
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  type FakeDom,
  TEST_THEME,
  findCanvasByLayer,
  installFakeDom,
  restoreRealTerminalModules,
} from './test-support/fake-dom';
import type { GhosttyRenderRow, PredictionFrame, TerminalPredictionHost } from './types';

const COLS = 32;
const ROWS = 6;

type TestTerminal = {
  prediction: TerminalPredictionHost;
  lastRenderedRows: GhosttyRenderRow[];
  open(container: HTMLElement): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  reset(): void;
  refresh(): void;
  scrollLines(amount: number): boolean;
  scrollToBottom(): boolean;
  dispose(): void;
};

let dom: FakeDom | null = null;
let activeTerminal: TestTerminal | null = null;
let importVersion = 0;

afterEach(() => {
  activeTerminal?.dispose();
  activeTerminal = null;
  dom?.restore();
  dom = null;
});

afterAll(() => {
  restoreRealTerminalModules();
});

async function flush(fakeDom: FakeDom): Promise<void> {
  for (let index = 0; index < 4 && fakeDom.pendingAnimationFrames() > 0; index += 1) {
    await fakeDom.flushAnimationFrames();
  }
}

async function openTerminal(): Promise<{
  terminal: TestTerminal;
  fakeDom: FakeDom;
  container: ReturnType<FakeDom['document']['createElement']>;
  settle: () => Promise<void>;
}> {
  restoreRealTerminalModules();
  importVersion += 1;
  const { createTerminalController } = await import(`./terminal.ts?prediction=${importVersion}`);

  const fakeDom = installFakeDom();
  dom = fakeDom;
  const terminal = (await createTerminalController({
    theme: TEST_THEME,
    fontFamily: 'monospace',
    fontSize: 13,
    scrollback: 300,
  })) as TestTerminal;
  activeTerminal = terminal;

  const container = fakeDom.document.createElement('div');
  container.setBoundingClientRect({ width: 800, height: 480 });
  fakeDom.document.body.appendChild(container);
  terminal.open(container as unknown as HTMLElement);
  terminal.resize(COLS, ROWS);
  const settle = () => flush(fakeDom);
  await settle();
  return { terminal, fakeDom, container, settle };
}

function numberedLines(count: number, from = 0): string {
  return Array.from(
    { length: count },
    (_, index) => `line-${(from + index).toString().padStart(3, '0')}\r\n`
  ).join('');
}

function currentFrame(terminal: TestTerminal): PredictionFrame {
  const frame = terminal.prediction.frame();
  if (!frame) {
    throw new Error('prediction frame unavailable');
  }
  return frame;
}

describe('prediction frame', () => {
  test('首次渲染后有帧：尺寸、真实光标与格子内容', async () => {
    restoreRealTerminalModules();
    importVersion += 1;
    const { createTerminalController } = await import(`./terminal.ts?prediction=${importVersion}`);
    const fakeDom = installFakeDom();
    dom = fakeDom;
    const terminal = (await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 300,
    })) as TestTerminal;
    activeTerminal = terminal;
    expect(terminal.prediction.frame()).toBeNull();

    const container = fakeDom.document.createElement('div');
    container.setBoundingClientRect({ width: 800, height: 480 });
    fakeDom.document.body.appendChild(container);
    terminal.open(container as unknown as HTMLElement);
    terminal.resize(COLS, ROWS);
    terminal.write('abc');
    await flush(fakeDom);

    const frame = currentFrame(terminal);
    expect(frame.cols).toBe(COLS);
    expect(frame.rows).toBe(ROWS);
    expect(frame.cursor).toEqual({ row: 0, col: 3, visible: true, passwordInput: false });
    expect(frame.cellAt(0, 0)).toEqual({ text: 'a', wide: false });
    expect(frame.cellAt(0, 2)).toEqual({ text: 'c', wide: false });
    expect(frame.cellAt(0, 10)).toEqual({ text: ' ', wide: false });
    expect(frame.cellAt(ROWS, 0)).toBeNull();
    expect(frame.cellAt(0, COLS)).toBeNull();
    expect(frame.viewportAtBottom).toBeTrue();
    expect(frame.altScreen).toBeFalse();
    expect(frame.mouseReporting).toBeFalse();
    expect(frame.synchronizedOutput).toBeFalse();
  });

  test('宽字符占两列，尾列 spacer 读出空串；光标按两列步进', async () => {
    const { terminal, settle } = await openTerminal();
    terminal.write('中x');
    await settle();

    const frame = currentFrame(terminal);
    expect(frame.cellAt(0, 0)).toEqual({ text: '中', wide: true });
    expect(frame.cellAt(0, 1)).toEqual({ text: '', wide: false });
    expect(frame.cellAt(0, 2)).toEqual({ text: 'x', wide: false });
    expect(frame.cursor.col).toBe(3);
    expect(terminal.prediction.textWidth('中')).toBe(2);
    expect(terminal.prediction.textWidth('x')).toBe(1);
  });

  test('alt screen（1049 / 1047）与鼠标上报跟随内核模式', async () => {
    const { terminal, settle } = await openTerminal();

    terminal.write('\x1b[?1049h');
    await settle();
    expect(currentFrame(terminal).altScreen).toBeTrue();

    terminal.write('\x1b[?1049l');
    await settle();
    expect(currentFrame(terminal).altScreen).toBeFalse();

    terminal.write('\x1b[?1047h');
    await settle();
    expect(currentFrame(terminal).altScreen).toBeTrue();
    terminal.write('\x1b[?1047l');
    await settle();

    terminal.write('\x1b[?1000h');
    await settle();
    expect(currentFrame(terminal).mouseReporting).toBeTrue();
    terminal.write('\x1b[?1000l');
    await settle();
    expect(currentFrame(terminal).mouseReporting).toBeFalse();
  });

  test('同步输出（2026）激活期间帧上标记 synchronizedOutput', async () => {
    const { terminal } = await openTerminal();

    terminal.write('\x1b[?2026h');
    terminal.refresh();
    expect(currentFrame(terminal).synchronizedOutput).toBeTrue();

    terminal.write('\x1b[?2026l');
    terminal.refresh();
    expect(currentFrame(terminal).synchronizedOutput).toBeFalse();
  });

  test('viewportTop 随行滚出顶部增长、随回滚减小；viewportAtBottom 同步翻转', async () => {
    const { terminal, settle } = await openTerminal();
    terminal.write(numberedLines(80));
    await settle();

    const atBottom = currentFrame(terminal);
    expect(atBottom.viewportAtBottom).toBeTrue();
    expect(atBottom.viewportTop).toBeGreaterThan(0);

    expect(terminal.scrollLines(-3)).toBeTrue();
    await settle();
    const scrolledBack = currentFrame(terminal);
    expect(scrolledBack.viewportAtBottom).toBeFalse();
    expect(scrolledBack.viewportTop).toBe(atBottom.viewportTop - 3);
    expect(scrolledBack.generation).toBe(atBottom.generation);

    expect(terminal.scrollToBottom()).toBeTrue();
    await settle();
    expect(currentFrame(terminal).viewportTop).toBe(atBottom.viewportTop);
    expect(currentFrame(terminal).viewportAtBottom).toBeTrue();

    terminal.write(numberedLines(10, 80));
    await settle();
    expect(currentFrame(terminal).viewportTop).toBe(atBottom.viewportTop + 10);
  });

  test('generation 在 resize / reset 之后的帧上递增；普通输出与同尺寸 resize 不变', async () => {
    const { terminal, settle } = await openTerminal();
    terminal.write('hello');
    await settle();
    const first = currentFrame(terminal).generation;

    terminal.write(' world');
    terminal.resize(COLS, ROWS);
    await settle();
    expect(currentFrame(terminal).generation).toBe(first);

    terminal.resize(COLS + 4, ROWS);
    expect(currentFrame(terminal).generation).toBe(first);
    await settle();
    const resized = currentFrame(terminal);
    expect(resized.generation).toBeGreaterThan(first);
    expect(resized.cols).toBe(COLS + 4);

    terminal.reset();
    await settle();
    const reset = currentFrame(terminal);
    expect(reset.generation).toBeGreaterThan(resized.generation);
    expect(reset.cellAt(0, 0)).toEqual({ text: ' ', wide: false });
    expect(reset.cursor).toEqual({ row: 0, col: 0, visible: true, passwordInput: false });
  });

  test('onFrame 在输出 / resize / reset 渲染完成后回调，取消订阅后停止', async () => {
    const { terminal, settle } = await openTerminal();
    const frames: PredictionFrame[] = [];
    const off = terminal.prediction.onFrame((frame) => frames.push(frame));

    terminal.write('a');
    await settle();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const afterWrite = frames.length;
    expect(frames.at(-1)?.cellAt(0, 0)?.text).toBe('a');

    terminal.resize(COLS + 2, ROWS);
    await settle();
    expect(frames.length).toBeGreaterThan(afterWrite);
    const resizeFrame = frames.at(-1) as PredictionFrame;
    expect(resizeFrame.cols).toBe(COLS + 2);
    expect(resizeFrame.generation).toBeGreaterThan(frames[0].generation);

    const afterResize = frames.length;
    terminal.reset();
    await settle();
    expect(frames.length).toBeGreaterThan(afterResize);
    expect((frames.at(-1) as PredictionFrame).generation).toBeGreaterThan(resizeFrame.generation);

    off();
    const afterOff = frames.length;
    terminal.write('b');
    await settle();
    expect(frames).toHaveLength(afterOff);
  });
});

describe('prediction overlay', () => {
  const OVERLAY = {
    cells: [{ row: 0, col: 0, text: 'x', wide: false, underline: true }],
    cursor: { row: 0, col: 2 },
  };

  test('setOverlay 只画 prediction 层，模拟器网格与真实光标不变', async () => {
    const { terminal, container, settle } = await openTerminal();
    expect(findCanvasByLayer(container, 'prediction')).toBeNull();
    const before = currentFrame(terminal);

    terminal.prediction.setOverlay(OVERLAY);
    const layer = findCanvasByLayer(container, 'prediction');
    expect(layer).not.toBeNull();
    const texts = layer?.context.operations.filter((operation) => operation.type === 'fillText');
    expect(texts?.map((operation) => operation.text)).toEqual(['x']);

    await settle();
    const after = currentFrame(terminal);
    expect(after.cellAt(0, 0)).toEqual({ text: ' ', wide: false });
    expect(after.cursor).toEqual(before.cursor);
    expect(terminal.lastRenderedRows[0]?.text.trim()).toBe('');
  });

  test('reset / resize 立即擦掉 overlay，之后的帧不会把它画回来', async () => {
    const { terminal, container, settle } = await openTerminal();
    const layer = () => findCanvasByLayer(container, 'prediction');
    const drawn = () =>
      layer()?.context.operations.filter((operation) => operation.type === 'fillText').length ?? 0;

    terminal.prediction.setOverlay(OVERLAY);
    const baseline = drawn();
    expect(baseline).toBe(1);

    terminal.reset();
    expect(layer()?.context.operations.at(-1)?.type).toBe('clearRect');
    await settle();
    expect(drawn()).toBe(baseline);

    terminal.prediction.setOverlay(OVERLAY);
    const redrawn = drawn();
    terminal.resize(COLS + 3, ROWS);
    expect(layer()?.context.operations.at(-1)?.type).toBe('clearRect');
    await settle();
    expect(drawn()).toBe(redrawn);
  });

  test('null 清除 overlay', async () => {
    const { terminal, container } = await openTerminal();

    terminal.prediction.setOverlay(OVERLAY);
    terminal.prediction.setOverlay(null);
    expect(findCanvasByLayer(container, 'prediction')?.context.operations.at(-1)?.type).toBe(
      'clearRect'
    );
  });

  test('从未设置 overlay 的终端没有 prediction 层，null 也不会创建', async () => {
    const { terminal, container, settle } = await openTerminal();
    terminal.prediction.setOverlay(null);
    terminal.write('a');
    await settle();
    expect(findCanvasByLayer(container, 'prediction')).toBeNull();
  });
});
