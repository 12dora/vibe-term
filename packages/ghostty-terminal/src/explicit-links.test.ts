// OSC 8 explicit 链接模型：URI 分类（POLICY「Link kinds」）、按 URI 分段、按 cells 身份缓存与
// 视口坐标换算（渲染后 ghostty 视口又滚动时仍查同一绝对行）。
import { describe, expect, test } from 'bun:test';
import {
  type ExplicitLinkGrid,
  ExplicitLinkIndex,
  type ExplicitRowSpans,
  MAX_EXPLICIT_URI_LENGTH,
  buildExplicitSpans,
  classifyExplicitUri,
  explicitSpanHit,
} from './explicit-links';
import type { FileLinkContext } from './file-path';
import { cellsFromText } from './test-support/selection-line-model';
import type { GhosttyRenderCell, GhosttyRenderRow } from './types';

const CONTEXT: FileLinkContext = { cwd: '/repo', rootPaths: ['/repo'] };

describe('classifyExplicitUri', () => {
  test('http / https 原样作为 url', () => {
    expect(classifyExplicitUri('https://example.com/a?b=1#c', null)).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b=1#c',
    });
    expect(classifyExplicitUri('http://example.com', null)).toEqual({
      kind: 'url',
      url: 'http://example.com',
    });
  });

  test('file: 取 pathname 解码并按授权根校验，host 忽略', () => {
    expect(classifyExplicitUri('file:///repo/src/a%20b.ts', CONTEXT)).toEqual({
      kind: 'file',
      path: '/repo/src/a b.ts',
    });
    expect(classifyExplicitUri('file://host.example/repo/x.ts', CONTEXT)).toEqual({
      kind: 'file',
      path: '/repo/x.ts',
    });
  });

  test('file: 越出授权根、无上下文或解码失败都不是链接', () => {
    expect(classifyExplicitUri('file:///etc/passwd', CONTEXT)).toBeNull();
    expect(classifyExplicitUri('file:///repo/x.ts', null)).toBeNull();
    expect(classifyExplicitUri('file:///repo/%E0%A4%A', CONTEXT)).toBeNull();
  });

  test('其它 scheme 与不可解析的 URI 不是链接', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'vscode://file/repo/a.ts',
      'mailto:a@example.com',
      'not a uri',
      '/repo/a.ts',
      '',
    ]) {
      expect(classifyExplicitUri(uri, CONTEXT)).toBeNull();
    }
  });

  test('首尾空白与任意 C0 / DEL 控制字符一律拒绝（new URL 会静默剥离它们）', () => {
    for (const uri of [
      ' https://example.com',
      'https://example.com ',
      '\thttps://example.com',
      'ht\ttp://example.com/a',
      'https://example.com/a\nb',
      'https://example.com/\r',
      'https://example.com/\u0000',
      'https://example.com/\u001b[31m',
      'https://example.com/\u007f',
    ]) {
      expect(classifyExplicitUri(uri, null)).toBeNull();
    }
    expect(classifyExplicitUri('https://example.com/a b', null)).toEqual({
      kind: 'url',
      url: 'https://example.com/a b',
    });
  });

  test('超过 4096 字符不是链接，恰好 4096 仍是', () => {
    const prefix = 'https://example.com/';
    const exact = prefix + 'a'.repeat(MAX_EXPLICIT_URI_LENGTH - prefix.length);
    expect(classifyExplicitUri(exact, null)).toEqual({ kind: 'url', url: exact });
    expect(classifyExplicitUri(`${exact}a`, null)).toBeNull();
  });
});

function uriMap(map: Record<number, string>): (col: number) => string | null {
  return (col) => map[col] ?? null;
}

function spansOf(result: ExplicitRowSpans) {
  return result.spans.map(({ startCol, endCol, uri }) => [startCol, endCol, uri]);
}

describe('buildExplicitSpans', () => {
  test('连续同 URI 的标记格合成一段，文本取可见字符', () => {
    const cells = cellsFromText('see label!', (x) => x >= 4 && x <= 8);
    const uri = 'https://e.com';
    const result = buildExplicitSpans(cells, uriMap({ 4: uri, 5: uri, 6: uri, 7: uri, 8: uri }));
    expect(result).toEqual({
      spans: [{ startCol: 4, endCol: 8, uri: 'https://e.com', text: 'label' }],
      complete: true,
    });
  });

  test('相邻但 URI 不同的格子分成两段；未标记格子断开同 URI 的两段', () => {
    const cells = cellsFromText('abxcd', (x) => x !== 2);
    const result = buildExplicitSpans(
      cells,
      uriMap({ 0: 'https://a', 1: 'https://b', 3: 'https://b', 4: 'https://b' })
    );
    expect(spansOf(result)).toEqual([
      [0, 0, 'https://a'],
      [1, 1, 'https://b'],
      [3, 4, 'https://b'],
    ]);
  });

  test('宽字符未带标记的 spacer-tail 并入前一段', () => {
    const cells: GhosttyRenderCell[] = cellsFromText('界_x', (x) => x === 0);
    cells[1] = { ...cells[1], text: '', widthKind: 'spacer-tail' };
    cells[0] = { ...cells[0], widthKind: 'wide' };
    const result = buildExplicitSpans(cells, uriMap({ 0: 'https://wide' }));
    expect(result.spans).toEqual([{ startCol: 0, endCol: 1, uri: 'https://wide', text: '界' }]);
  });

  test('行尾 spacer-head 即便带标记也不成段、不查 URI', () => {
    const cells: GhosttyRenderCell[] = cellsFromText('abcd_', (x) => x === 4);
    cells[4] = { ...cells[4], text: '', widthKind: 'spacer-head' };
    const reads: number[] = [];
    const result = buildExplicitSpans(cells, (col) => {
      reads.push(col);
      return 'https://wrap';
    });
    expect(result).toEqual({ spans: [], complete: true });
    expect(reads).toEqual([]);
  });

  test('读不到（null）：标记格仍成段（压制正则）但 uri 为空，且整行 complete=false', () => {
    const cells = cellsFromText('abc', (x) => x < 2);
    expect(buildExplicitSpans(cells, null)).toEqual({
      spans: [{ startCol: 0, endCol: 1, uri: '', text: 'ab' }],
      complete: false,
    });
    const partial = buildExplicitSpans(cells, uriMap({ 0: 'https://a' }));
    expect(spansOf(partial)).toEqual([
      [0, 0, 'https://a'],
      [1, 1, ''],
    ]);
    expect(partial.complete).toBe(false);
  });

  test('被拒（读回空串，如超长）：uri 为空但 complete=true，可缓存', () => {
    const cells = cellsFromText('ab', () => true);
    expect(buildExplicitSpans(cells, () => '')).toEqual({
      spans: [{ startCol: 0, endCol: 1, uri: '', text: 'ab' }],
      complete: true,
    });
  });
});

describe('explicitSpanHit', () => {
  const span = (text: string, uri: string) => ({ startCol: 0, endCol: 0, uri, text });

  test('可见文本与 URI 不同才给 tooltip（markdown 标签 / 硬换行片段）', () => {
    expect(explicitSpanHit(span('label', 'https://e.com/a'), null)).toEqual({
      kind: 'url',
      url: 'https://e.com/a',
      explicit: true,
      tooltip: 'https://e.com/a',
    });
    expect(explicitSpanHit(span(' https://e.com/a ', 'https://e.com/a'), null)).toEqual({
      kind: 'url',
      url: 'https://e.com/a',
      explicit: true,
    });
  });

  test('file 链接不给 tooltip；无效 URI 返回 null', () => {
    expect(explicitSpanHit(span('a.ts', 'file:///repo/a.ts'), CONTEXT)).toEqual({
      kind: 'file',
      path: '/repo/a.ts',
      explicit: true,
    });
    expect(explicitSpanHit(span('x', 'javascript:alert(1)'), CONTEXT)).toBeNull();
    expect(explicitSpanHit(span('x', ''), CONTEXT)).toBeNull();
  });

  test('结果按 fileLinkContext 身份记忆，上下文换新即重算', () => {
    const fileSpan = span('a.ts', 'file:///repo/a.ts');
    expect(explicitSpanHit(fileSpan, null)).toBeNull();
    expect(explicitSpanHit(fileSpan, CONTEXT)?.kind).toBe('file');
    expect(explicitSpanHit(fileSpan, { rootPaths: ['/other'] })).toBeNull();
  });
});

type FakeViewport = { offset: number; rows: number };

function fakeGrid(uris: Record<string, string>, viewport: FakeViewport = { offset: 0, rows: 3 }) {
  const queries: string[] = [];
  let viewportReads = 0;
  const grid: ExplicitLinkGrid = {
    viewport: () => {
      viewportReads += 1;
      return { ...viewport };
    },
    uriAt: (x, y) => {
      queries.push(`${x},${y}`);
      return uris[`${x},${y}`] ?? null;
    },
    dispose: () => {},
  };
  return { grid, queries, viewport, viewportReads: () => viewportReads };
}

function row(y: number, cells: GhosttyRenderCell[]): GhosttyRenderRow {
  return { y, dirty: false, wrap: false, wrapContinuation: false, text: '', cells };
}

const flagged = (text: string) => cellsFromText(text, () => true);

describe('ExplicitLinkIndex', () => {
  test('无标记的行不查 grid_ref；有标记的行只查带标记的格子且按 cells 身份缓存', () => {
    const { grid, queries } = fakeGrid(
      { '1,1': 'https://x', '2,1': 'https://x' },
      { offset: 10, rows: 2 }
    );
    const index = new ExplicitLinkIndex(grid);
    const linked = (x: number) => x === 1 || x === 2;
    const rows = [row(0, cellsFromText('plain')), row(1, cellsFromText('axxb', linked))];

    const source = index.source(rows, 10, true);
    expect(source(10)).toEqual([]);
    const spans = source(11).map((span) => [span.startCol, span.endCol, span.uri]);
    expect(spans).toEqual([[1, 2, 'https://x']]);
    expect(queries).toEqual(['1,1', '2,1']);

    const again = index.source(rows, 10, true);
    again(10);
    again(11);
    expect(queries).toHaveLength(2);

    rows[1] = row(1, cellsFromText('axxb', linked));
    index.source(rows, 10, true)(11);
    expect(queries).toHaveLength(4);
  });

  test('视口外的行返回空', () => {
    const { grid } = fakeGrid({});
    const source = new ExplicitLinkIndex(grid).source([row(0, flagged('a'))], 5, true);
    expect(source(4)).toEqual([]);
    expect(source(6)).toEqual([]);
  });

  test('内核与渲染不同步（synced=false）：不查内核、不读视口、不缓存，同步后再查', () => {
    const { grid, queries, viewportReads } = fakeGrid({ '0,0': 'https://x' });
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, flagged('a'))];

    expect(index.source(rows, 0, false)(0)).toEqual([
      { startCol: 0, endCol: 0, uri: '', text: 'a' },
    ]);
    expect(queries).toEqual([]);
    expect(viewportReads()).toBe(0);

    expect(index.source(rows, 0, true)(0)[0]?.uri).toBe('https://x');
    expect(queries).toEqual(['0,0']);
  });

  test('已缓存的行在不同步时照常返回（缓存来自同步时刻，对应用户看到的这一行）', () => {
    const { grid, queries } = fakeGrid({ '0,0': 'https://x' });
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, flagged('a'))];
    index.source(rows, 0, true)(0);
    expect(index.source(rows, 0, false)(0)[0]?.uri).toBe('https://x');
    expect(queries).toHaveLength(1);
  });

  test('标记格读回 null 的行不缓存（下一次重查）', () => {
    const uris: Record<string, string> = {};
    const { grid, queries } = fakeGrid(uris);
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, flagged('a'))];

    expect(index.source(rows, 0, true)(0)[0]?.uri).toBe('');
    uris['0,0'] = 'https://late';
    expect(index.source(rows, 0, true)(0)[0]?.uri).toBe('https://late');
    expect(queries).toEqual(['0,0', '0,0']);
  });

  test('被拒（空串）的结果缓存，不再重查', () => {
    const { grid, queries } = fakeGrid({ '0,0': '' });
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, flagged('a'))];
    index.source(rows, 0, true)(0);
    index.source(rows, 0, true)(0);
    expect(queries).toHaveLength(1);
  });

  test('渲染后 ghostty 视口滚动：按当前视口顶换算到同一绝对行再查', () => {
    // 渲染时视口顶在绝对行 40，之后 ghostty 视口上滚 1 行到 39：绝对行 41 现在是视口 y=2。
    const { grid, queries } = fakeGrid({ '0,2': 'https://moved' }, { offset: 39, rows: 3 });
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, cellsFromText('a')), row(1, flagged('b')), row(2, cellsFromText('c'))];
    expect(index.source(rows, 40, true)(41)[0]?.uri).toBe('https://moved');
    expect(queries).toEqual(['0,2']);
  });

  test('可读范围按内核当前视口行数：缩行 resize 后越界的行不查不缓存', () => {
    const { grid, queries, viewport } = fakeGrid({ '0,2': 'https://x' }, { offset: 0, rows: 2 });
    const index = new ExplicitLinkIndex(grid);
    const rows = [row(0, cellsFromText('a')), row(1, cellsFromText('b')), row(2, flagged('c'))];

    expect(index.source(rows, 0, true)(2)).toEqual([
      { startCol: 0, endCol: 0, uri: '', text: 'c' },
    ]);
    expect(queries).toEqual([]);

    viewport.rows = 3;
    expect(index.source(rows, 0, true)(2)[0]?.uri).toBe('https://x');
  });

  test('一次 source 内只读一次视口', () => {
    const { grid, viewportReads } = fakeGrid({ '0,0': 'https://x', '0,1': 'https://y' });
    const source = new ExplicitLinkIndex(grid).source(
      [row(0, flagged('a')), row(1, flagged('b'))],
      0,
      true
    );
    source(0);
    source(1);
    expect(viewportReads()).toBe(1);
  });
});
