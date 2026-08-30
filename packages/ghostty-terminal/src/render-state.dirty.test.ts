// 行 dirty 短路：内核报「本行未脏」时 iterateRows 整行沿用上一帧、一个 cell 都不读。
// dirty 位遵循「消费即清」，读后必须写回 false，正确性完全押在内核的标脏范围上，
// 因此这里用差分测试钉死：同一批字节喂两台终端，一台跨帧复用、一台每步换新 render state
// （必然全扫），逐 cell 比对两者产出必须完全一致。
import { describe, expect, test } from 'bun:test';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import type { GhosttyRenderRow, GhosttyTheme } from './types';

const THEME: GhosttyTheme = {
  background: '#111111',
  foreground: '#eeeeee',
  cursor: '#eeeeee',
  selectionBackground: 'rgba(120,120,120,0.4)',
  black: '#000000',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

const THEME_LIGHT: GhosttyTheme = { ...THEME, background: '#fafafa', red: '#aa0000' };

const COLS = 24;
const ROWS = 6;

type Step = { name: string; run: (bindings: GhosttyBindings, terminal: number) => void };

const write =
  (data: string): Step['run'] =>
  (bindings, terminal) => {
    bindings.writeVt(terminal, data);
  };

// 覆盖「行内容可能变化」的各类来源：写入、擦除、光标移动、内容滚动、视口滚动、
// resize（含软换行重排）、主题换色、宽字符与组合字符。
const STEPS: Step[] = [
  { name: '初始填充', run: write('\x1b[2J\x1b[H') },
  ...Array.from({ length: 10 }, (_, index) => ({
    name: `写第 ${index} 行`,
    run: write(`line-${index} 内容 ${index}\r\n`),
  })),
  { name: '无输入的空帧', run: () => {} },
  { name: '改中间一行', run: write('\x1b[3;1HZZZ') },
  { name: '光标移到别处', run: write('\x1b[1;1H') },
  { name: '行内擦除', run: write('\x1b[2;3H\x1b[K') },
  { name: '带 SGR 写入', run: write('\x1b[4;1H\x1b[1;31mred bold\x1b[0m') },
  { name: '宽字符与组合字符', run: write('\x1b[5;1H宽字符 é ab') },
  { name: '内容滚动一行', run: write('\x1b[6;1H\n') },
  {
    name: '视口上滚 1 行',
    run: (bindings, terminal) => bindings.scrollViewportDelta(terminal, -1),
  },
  { name: '视口上滚后空帧', run: () => {} },
  { name: '视口下滚 1 行', run: (bindings, terminal) => bindings.scrollViewportDelta(terminal, 1) },
  { name: '视口回到顶部', run: (bindings, terminal) => bindings.scrollViewportTop(terminal) },
  { name: '视口回到底部', run: (bindings, terminal) => bindings.scrollViewportBottom(terminal) },
  { name: '软换行超长行', run: write(`\x1b[1;1H${'w'.repeat(COLS * 2 + 5)}`) },
  {
    name: 'resize 变窄（重排软换行）',
    run: (bindings, terminal) =>
      bindings.resizeTerminal(terminal, 16, ROWS, { width: 8, height: 16 }),
  },
  { name: 'resize 后空帧', run: () => {} },
  {
    name: 'resize 变宽',
    run: (bindings, terminal) =>
      bindings.resizeTerminal(terminal, COLS, ROWS, { width: 8, height: 16 }),
  },
  {
    name: '切换主题',
    run: (bindings, terminal) => bindings.setTerminalTheme(terminal, THEME_LIGHT),
  },
  { name: '切主题后空帧', run: () => {} },
  { name: '清屏', run: write('\x1b[2J\x1b[H') },
  { name: '备用屏', run: write('\x1b[?1049h\x1b[H alt screen ') },
  { name: '回主屏', run: write('\x1b[?1049l') },
];

// 只保留会被 canvas / 选择模型消费的字段：行几何、文本、逐 cell 的形与色。
function project(rows: GhosttyRenderRow[]): unknown {
  return rows.map((row) => ({
    y: row.y,
    wrap: row.wrap,
    wrapContinuation: row.wrapContinuation,
    text: row.text,
    cells: row.cells.map((cell) => ({
      x: cell.x,
      text: cell.text,
      codepoints: [...cell.codepoints],
      widthKind: cell.widthKind,
      hasText: cell.hasText,
      style: { ...cell.style },
      fgColor: cell.fgColor ? { ...cell.fgColor } : null,
      bgColor: cell.bgColor ? { ...cell.bgColor } : null,
    })),
  }));
}

// 只截 bindRenderStateRowCells：它是「本行走了逐 cell 全扫」的唯一入口。
function countingBindings(bindings: GhosttyBindings): {
  proxy: GhosttyBindings;
  scannedRows: () => number;
} {
  let scanned = 0;
  const proxy = new Proxy(bindings, {
    get(target, prop) {
      if (prop === 'bindRenderStateRowCells') {
        return (iterator: number, cells: number) => {
          scanned += 1;
          target.bindRenderStateRowCells(iterator, cells);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as GhosttyBindings;

  return { proxy, scannedRows: () => scanned };
}

describe('行 dirty 短路', () => {
  test('跨帧复用与每帧全扫的产出逐 cell 一致', async () => {
    const bindings = await getGhosttyBindings();
    const reused = bindings.createTerminal(COLS, ROWS, 200);
    const fresh = bindings.createTerminal(COLS, ROWS, 200);
    bindings.setTerminalTheme(reused, THEME);
    bindings.setTerminalTheme(fresh, THEME);
    const reusedState = createRenderState(bindings);

    try {
      for (const step of STEPS) {
        step.run(bindings, reused);
        step.run(bindings, fresh);

        updateRenderState(reusedState, reused);
        const actual = project(Array.from(iterateRows(reusedState)));

        // 全新 render state 没有上一帧可比，必然逐 cell 全扫，作为基准真值。
        const freshState = createRenderState(bindings);
        updateRenderState(freshState, fresh);
        const expected = project(Array.from(iterateRows(freshState)));
        disposeRenderStateResources(freshState);

        expect({ step: step.name, rows: actual }).toEqual({ step: step.name, rows: expected });
      }
    } finally {
      disposeRenderStateResources(reusedState);
      bindings.freeTerminal(reused);
      bindings.freeTerminal(fresh);
    }
  });

  test('未脏的行不读任何 cell，被改的行才全扫', async () => {
    const real = await getGhosttyBindings();
    const { proxy, scannedRows } = countingBindings(real);
    const terminal = proxy.createTerminal(COLS, ROWS, 200);
    const state = createRenderState(proxy);

    const frame = () => {
      updateRenderState(state, terminal);
      const rows = Array.from(iterateRows(state));
      return { rows, meta: readRenderSnapshotMeta(state) };
    };

    try {
      proxy.writeVt(terminal, 'alpha\r\nbeta\r\ngamma');
      const first = frame();
      // 首帧没有可比基线：每一行都要全扫。
      expect(scannedRows()).toBe(ROWS);
      expect(first.meta.dirty).toBe('full');

      const before = scannedRows();
      const idle = frame();
      expect(scannedRows()).toBe(before);
      expect(idle.meta.dirty).toBe('clean');
      for (let index = 0; index < idle.rows.length; index += 1) {
        expect(idle.rows[index].cells).toBe(first.rows[index].cells);
      }

      // 改第 1 行：内核把该行与光标离开的行标脏，只有这些行才重新扫 cell。
      const beforeWrite = scannedRows();
      proxy.writeVt(terminal, '\x1b[1;1HZ');
      const after = frame();
      const rescanned = scannedRows() - beforeWrite;
      expect(rescanned).toBeGreaterThan(0);
      expect(rescanned).toBeLessThan(ROWS);
      expect(after.meta.dirty).toBe('partial');
      expect(after.rows[0].dirty).toBeTrue();
      expect(after.rows[0].text.startsWith('Z')).toBeTrue();
      expect(after.rows[5].cells).toBe(first.rows[5].cells);
    } finally {
      disposeRenderStateResources(state);
      proxy.freeTerminal(terminal);
    }
  });

  test('视口滚动一行后所有行重画且内容正确', async () => {
    const bindings = await getGhosttyBindings();
    const terminal = bindings.createTerminal(COLS, 4, 200);
    const state = createRenderState(bindings);

    const frame = () => {
      updateRenderState(state, terminal);
      const rows = Array.from(iterateRows(state));
      return { rows, meta: readRenderSnapshotMeta(state) };
    };

    try {
      for (let index = 0; index < 12; index += 1) {
        bindings.writeVt(terminal, `line-${index}\r\n`);
      }
      frame();
      expect(frame().meta.dirty).toBe('clean');

      bindings.scrollViewportDelta(terminal, -1);
      const scrolled = frame();
      expect(scrolled.meta.dirty).toBe('full');
      expect(scrolled.rows.every((row) => row.dirty)).toBeTrue();
      expect(scrolled.rows.map((row) => row.text.trimEnd())).toEqual([
        'line-8',
        'line-9',
        'line-10',
        'line-11',
      ]);

      bindings.scrollViewportDelta(terminal, 1);
      const back = frame();
      expect(back.rows.map((row) => row.text.trimEnd())).toEqual([
        'line-9',
        'line-10',
        'line-11',
        '',
      ]);
    } finally {
      disposeRenderStateResources(state);
      bindings.freeTerminal(terminal);
    }
  });

  test('迭代中途中断后丢弃缓存，下一帧全扫重建', async () => {
    const real = await getGhosttyBindings();
    const { proxy, scannedRows } = countingBindings(real);
    const terminal = proxy.createTerminal(COLS, ROWS, 200);
    const state = createRenderState(proxy);

    try {
      proxy.writeVt(terminal, 'alpha\r\nbeta');
      updateRenderState(state, terminal);
      Array.from(iterateRows(state));

      // 只消费前两行就丢下生成器：这两行的 dirty 位已被消费，缓存必须整体作废。
      updateRenderState(state, terminal);
      const partial = iterateRows(state);
      partial.next();
      partial.next();
      partial.return(undefined);

      const before = scannedRows();
      updateRenderState(state, terminal);
      const rows = Array.from(iterateRows(state));
      expect(scannedRows() - before).toBe(ROWS);
      expect(rows[0].text.startsWith('alpha')).toBeTrue();
      expect(rows[1].text.startsWith('beta')).toBeTrue();
    } finally {
      disposeRenderStateResources(state);
      proxy.freeTerminal(terminal);
    }
  });
});
