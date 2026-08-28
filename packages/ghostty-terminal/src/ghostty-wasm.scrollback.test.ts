// createTerminal 的 scrollback 单位回归：调用方给的是「行」，ghostty 的 max_scrollback 是「字节」。
// 直接透传时无论传 1e4 还是 1e6，80 列下都只留 1129 行（字节数被 PageList 的下限兜住）。
// PageList 按整页（实测 576 KiB）切分，且每行实际占用随内容（样式、宽字符）浮动，
// 所以实际保留行数只能落在页粒度上：断言「不少于请求值、且超出不到 EXCESS_ROWS」。
import { describe, expect, test } from 'bun:test';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';

const ROWS = 24;
const EXCESS_ROWS = 1100;

function feedLines(bindings: GhosttyBindings, terminal: number, cols: number, lines: number): void {
  const filler = 'x'.repeat(Math.max(1, cols - 20));
  let chunk = '';
  for (let index = 0; index < lines; index += 1) {
    chunk += `line ${index} ${filler}\r\n`;
    if (chunk.length > 32 * 1024) {
      bindings.writeVt(terminal, chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) bindings.writeVt(terminal, chunk);
}

function retainedRows(
  bindings: GhosttyBindings,
  cols: number,
  scrollbackLines: number,
  writeLines: number
): number {
  const terminal = bindings.createTerminal(cols, ROWS, scrollbackLines);
  try {
    feedLines(bindings, terminal, cols, writeLines);
    return bindings.readScrollbar(terminal).total;
  } finally {
    bindings.freeTerminal(terminal);
  }
}

function blankLineRows(
  bindings: GhosttyBindings,
  cols: number,
  scrollbackLines: number,
  writeLines: number
): number {
  const terminal = bindings.createTerminal(cols, ROWS, scrollbackLines);
  try {
    bindings.writeVt(terminal, '\r\n'.repeat(writeLines));
    return bindings.readScrollbar(terminal).total;
  } finally {
    bindings.freeTerminal(terminal);
  }
}

describe('createTerminal scrollback 以行为单位', () => {
  test('80 列请求 3000 行，写 4000 行后至少保留 3000 行', async () => {
    const bindings = await getGhosttyBindings();
    const total = retainedRows(bindings, 80, 3000, 4000);

    expect(total).toBeGreaterThanOrEqual(3000 + ROWS);
    expect(total).toBeLessThanOrEqual(3000 + ROWS + EXCESS_ROWS);
  });

  test('160 列请求 3000 行，写 4000 行后至少保留 3000 行', async () => {
    const bindings = await getGhosttyBindings();
    const total = retainedRows(bindings, 160, 3000, 4000);

    expect(total).toBeGreaterThanOrEqual(3000 + ROWS);
    expect(total).toBeLessThanOrEqual(3000 + ROWS + EXCESS_ROWS);
  });

  // 只喂空行：行槽按行计，空行同样占满一格，容量测量不受内容波动影响，也不必写 MB 级字节
  test('请求 10000 行不再退化成 1129 行（单位 bug 的直接回归）', async () => {
    const bindings = await getGhosttyBindings();
    const total = blankLineRows(bindings, 80, 10000, 12000);

    expect(total).toBeGreaterThanOrEqual(10000 + ROWS);
  });

  test('超过上限的请求被夹到 10000 行，不会无限吃内存', async () => {
    const bindings = await getGhosttyBindings();
    const total = blankLineRows(bindings, 80, 1_000_000, 12000);

    expect(total).toBeLessThanOrEqual(10000 + ROWS + EXCESS_ROWS);
  });
});
