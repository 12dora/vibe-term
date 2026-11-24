import { describe, expect, mock, spyOn, test } from 'bun:test';
import { TerminalPredictionHostImpl, readPredictionCell } from './terminal-prediction';
import type {
  GhosttyCellWidthKind,
  GhosttyRenderCell,
  GhosttyRenderCursor,
  GhosttyRenderRow,
  PredictionFrame,
  PredictionOverlay,
} from './types';

const STYLE = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
};

function makeCell(x: number, text: string, widthKind: GhosttyCellWidthKind = 'narrow') {
  return {
    x,
    text,
    codepoints: Array.from(text, (char) => char.codePointAt(0) ?? 32),
    widthKind,
    hasText: text !== '',
    style: STYLE,
    fgColor: null,
    bgColor: null,
  } satisfies GhosttyRenderCell;
}

function makeRow(y: number, cells: GhosttyRenderCell[]): GhosttyRenderRow {
  return {
    y,
    dirty: false,
    wrap: false,
    wrapContinuation: false,
    text: cells.map((cell) => cell.text).join(''),
    cells,
  };
}

function makeCursor(overrides: Partial<GhosttyRenderCursor> = {}): GhosttyRenderCursor {
  return {
    style: 'block',
    visible: true,
    blinking: false,
    passwordInput: false,
    x: 2,
    y: 1,
    wideTail: false,
    ...overrides,
  };
}

// 行 0：a 中(wide) spacer-tail 空格；行 1：全空
const LINES = [
  makeRow(0, [
    makeCell(0, 'a'),
    makeCell(1, '中', 'wide'),
    makeCell(2, '', 'spacer-tail'),
    makeCell(3, ''),
    makeCell(4, '', 'spacer-head'),
  ]),
  makeRow(1, [makeCell(0, ''), makeCell(1, ''), makeCell(2, ''), makeCell(3, ''), makeCell(4, '')]),
];

function createHost() {
  const modes = mock(() => ({ altScreen: true, mouseReporting: false, synchronizedOutput: true }));
  const applyOverlay = mock((_overlay: PredictionOverlay | null) => {});
  const textWidth = mock((text: string): 1 | 2 => (text === '中' ? 2 : 1));
  const host = new TerminalPredictionHostImpl({ modes, applyOverlay, textWidth });
  return { host, modes, applyOverlay, textWidth };
}

function render(
  host: TerminalPredictionHostImpl,
  options: { top?: number; bottom?: boolean; cursor?: GhosttyRenderCursor | null } = {}
): void {
  host.noteRender({
    cols: 5,
    rows: 2,
    viewportTop: options.top ?? 7,
    viewportAtBottom: options.bottom ?? true,
    cursor: options.cursor === undefined ? makeCursor() : options.cursor,
    lines: LINES,
  });
}

describe('TerminalPredictionHostImpl 帧数据', () => {
  test('首次渲染前 frame() 为 null，渲染后给出光标 / 视口 / 尺寸', () => {
    const { host } = createHost();
    expect(host.frame()).toBeNull();

    render(host, { top: 12, bottom: false });
    const frame = host.frame();
    expect(frame).not.toBeNull();
    expect(frame?.cols).toBe(5);
    expect(frame?.rows).toBe(2);
    expect(frame?.cursor).toEqual({ row: 1, col: 2, visible: true, passwordInput: false });
    expect(frame?.viewportTop).toBe(12);
    expect(frame?.viewportAtBottom).toBe(false);
    expect(host.frame()).toBe(frame);
  });

  test('passwordInput 与光标可见性来自真实光标快照', () => {
    const { host } = createHost();
    render(host, { cursor: makeCursor({ passwordInput: true }) });
    expect(host.frame()?.cursor.passwordInput).toBeTrue();

    render(host, { cursor: makeCursor({ visible: false }) });
    expect(host.frame()?.cursor.visible).toBeFalse();

    render(host, { cursor: makeCursor({ x: null, y: null }) });
    expect(host.frame()?.cursor).toEqual({ row: 0, col: 0, visible: false, passwordInput: false });
  });

  test('光标快照缺失（未出帧）时 frame() 仍为 null', () => {
    const { host } = createHost();
    render(host, { cursor: null });
    expect(host.frame()).toBeNull();
  });

  test('模式位首次读取才查内核，三个字段共用一次查询', () => {
    const { host, modes } = createHost();
    render(host);
    expect(modes).toHaveBeenCalledTimes(0);

    const frame = host.frame() as PredictionFrame;
    expect(modes).toHaveBeenCalledTimes(0);
    expect(frame.altScreen).toBeTrue();
    expect(frame.mouseReporting).toBeFalse();
    expect(frame.synchronizedOutput).toBeTrue();
    expect(modes).toHaveBeenCalledTimes(1);
  });

  test('generation 随 invalidate 递增，但只随下一帧发布', () => {
    const { host } = createHost();
    render(host);
    const before = host.frame()?.generation ?? -1;

    host.invalidate();
    expect(host.frame()?.generation).toBe(before);

    render(host);
    expect(host.frame()?.generation).toBe(before + 1);

    render(host);
    expect(host.frame()?.generation).toBe(before + 1);

    host.invalidate();
    host.invalidate();
    render(host);
    expect(host.frame()?.generation).toBe(before + 3);
  });
});

describe('cellAt', () => {
  test('窄字符、宽字符、spacer 与空白格', () => {
    expect(readPredictionCell(LINES, 5, 0, 0)).toEqual({ text: 'a', wide: false });
    expect(readPredictionCell(LINES, 5, 0, 1)).toEqual({ text: '中', wide: true });
    expect(readPredictionCell(LINES, 5, 0, 2)).toEqual({ text: '', wide: false });
    expect(readPredictionCell(LINES, 5, 0, 3)).toEqual({ text: ' ', wide: false });
    expect(readPredictionCell(LINES, 5, 0, 4)).toEqual({ text: '', wide: false });
    expect(readPredictionCell(LINES, 5, 1, 0)).toEqual({ text: ' ', wide: false });
  });

  test('越界与非整数坐标返回 null', () => {
    expect(readPredictionCell(LINES, 5, -1, 0)).toBeNull();
    expect(readPredictionCell(LINES, 5, 2, 0)).toBeNull();
    expect(readPredictionCell(LINES, 5, 0, -1)).toBeNull();
    expect(readPredictionCell(LINES, 5, 0, 5)).toBeNull();
    expect(readPredictionCell(LINES, 5, 0.5, 0)).toBeNull();
    expect(readPredictionCell(LINES, 5, 0, Number.NaN)).toBeNull();
  });

  test('帧上的 cellAt 读取该帧的渲染行', () => {
    const { host } = createHost();
    render(host);
    expect(host.frame()?.cellAt(0, 1)).toEqual({ text: '中', wide: true });
  });
});

describe('onFrame / setOverlay / textWidth', () => {
  test('每次渲染完成都回调同一个帧对象；取消订阅后不再回调', () => {
    const { host } = createHost();
    const seen: PredictionFrame[] = [];
    const off = host.onFrame((frame) => seen.push(frame));

    render(host);
    render(host, { top: 9 });
    expect(seen).toHaveLength(2);
    expect(seen[1].viewportTop).toBe(9);
    expect(seen[1]).toBe(host.frame() as PredictionFrame);

    off();
    render(host);
    expect(seen).toHaveLength(2);
  });

  test('某个订阅者抛错不影响其他订阅者与渲染', () => {
    const { host } = createHost();
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const seen: number[] = [];
    host.onFrame(() => {
      throw new Error('boom');
    });
    host.onFrame((frame) => seen.push(frame.viewportTop));

    expect(() => render(host, { top: 3 })).not.toThrow();
    expect(seen).toEqual([3]);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  test('订阅者在回调里取消自己不会打乱遍历', () => {
    const { host } = createHost();
    const order: string[] = [];
    const offFirst = host.onFrame(() => {
      order.push('first');
      offFirst();
    });
    host.onFrame(() => order.push('second'));

    render(host);
    render(host);
    expect(order).toEqual(['first', 'second', 'second']);
  });

  test('setOverlay / textWidth 委托给宿主依赖', () => {
    const { host, applyOverlay, textWidth } = createHost();
    const overlay: PredictionOverlay = {
      cells: [{ row: 0, col: 0, text: 'x', wide: false, underline: true }],
      cursor: { row: 0, col: 1 },
    };
    host.setOverlay(overlay);
    host.setOverlay(null);
    expect(applyOverlay.mock.calls).toEqual([[overlay], [null]]);

    expect(host.textWidth('中')).toBe(2);
    expect(host.textWidth('a')).toBe(1);
    expect(textWidth).toHaveBeenCalledTimes(2);
  });

  test('dispose 清空订阅与帧', () => {
    const { host } = createHost();
    const seen: PredictionFrame[] = [];
    host.onFrame((frame) => seen.push(frame));
    render(host);
    host.dispose();

    expect(host.frame()).toBeNull();
    render(host, { cursor: null });
    expect(seen).toHaveLength(1);
  });
});
