// 链接检测的缓存键：改成整段 join 之后必须与逐字符拼接的老实现逐位一致，
// 否则整屏的检测结果缓存会全部落空。
import { describe, expect, test } from 'bun:test';
import type { ExplicitLinkSpan } from './explicit-links';
import { EMPTY_SELECTION_LINE_MODEL, type SelectionLineModel } from './selection-model';
import {
  LinkMatchCache,
  cacheKey,
  collectLinkUnderlineSegments,
  findLinkAtPoint,
} from './terminal-links';
import { lineModelFromText } from './test-support/selection-line-model';

// 老实现（逐字符 +=），仅用于等价性比对
function legacyCacheKey(models: SelectionLineModel[]): string {
  let key = '';
  for (const model of models) {
    for (const ch of model.colChars) {
      key += ch ?? '\u0000';
    }
    key += '\u0001';
  }
  return key;
}

function withHoles(text: string): SelectionLineModel {
  const model = lineModelFromText(text);
  return { ...model, colChars: model.colChars.map((ch, index) => (index % 3 === 1 ? null : ch)) };
}

describe('cacheKey', () => {
  const cases: Array<[string, SelectionLineModel[]]> = [
    ['空行集', []],
    ['单行', [lineModelFromText('https://example.com/a')]],
    ['空文本行', [lineModelFromText('')]],
    [
      '软换行多行',
      [lineModelFromText('see https://example.com/very', true), lineModelFromText('/long/path')],
    ],
    ['含空洞（宽字符尾列为 null）', [withHoles('宽字符 wide text 混排')]],
    ['含空格与标点', [lineModelFromText('ab c/d.e')]],
  ];

  for (const [name, models] of cases) {
    test(`与逐字符拼接等价：${name}`, () => {
      expect(cacheKey(models)).toBe(legacyCacheKey(models));
    });
  }

  test('不同内容得到不同键', () => {
    expect(cacheKey([lineModelFromText('abc')])).not.toBe(cacheKey([lineModelFromText('abd')]));
    // 行边界不能被内容伪造：两行 a / b 与单行 ab 必须不同
    expect(cacheKey([lineModelFromText('a'), lineModelFromText('b')])).not.toBe(
      cacheKey([lineModelFromText('ab')])
    );
  });
});

describe('LinkMatchCache', () => {
  test('同一文本只跑一次检测（命中缓存返回同一数组）', () => {
    const cache = new LinkMatchCache(4);
    const first = cache.detect([lineModelFromText('open https://example.com/x now')]);
    const second = cache.detect([lineModelFromText('open https://example.com/x now')]);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test('超出上限时淘汰最旧的条目', () => {
    const cache = new LinkMatchCache(2);
    const a = cache.detect([lineModelFromText('https://a.example/1')]);
    cache.detect([lineModelFromText('https://b.example/2')]);
    cache.detect([lineModelFromText('https://c.example/3')]);

    expect(cache.detect([lineModelFromText('https://a.example/1')])).not.toBe(a);
  });
});

// POLICY：explicit 优先；与 explicit 段重叠的正则匹配既不命中也不画下划线；带标记但 URI
// 不可打开的格子同样压制正则。
describe('explicit 与 detected 的重叠优先级', () => {
  const TEXT = 'go https://shown.example/x end https://plain.example';
  const LABEL_START = 3;
  const LABEL_END = 3 + 'https://shown.example/x'.length - 1;
  const PLAIN_START = TEXT.indexOf('https://plain.example');

  function query(spans: ExplicitLinkSpan[]) {
    const model = lineModelFromText(TEXT);
    return {
      getLineModel: (line: number) => (line === 0 ? model : EMPTY_SELECTION_LINE_MODEL),
      cache: new LinkMatchCache(4),
      fileLinkContext: null,
      explicitLinks: (line: number) => (line === 0 ? spans : []),
    };
  }

  function explicitSpan(uri: string): ExplicitLinkSpan {
    return { startCol: LABEL_START, endCol: LABEL_END, uri, text: 'https://shown.example/x' };
  }

  test('点在 explicit 段上命中 explicit URI，而非屏幕上的正则文本', () => {
    const hit = findLinkAtPoint({
      ...query([explicitSpan('https://real.example/y')]),
      line: 0,
      col: LABEL_START + 2,
    });
    expect(hit).toEqual({
      kind: 'url',
      url: 'https://real.example/y',
      explicit: true,
      tooltip: 'https://real.example/y',
    });
  });

  test('不重叠的正则链接照常命中（explicit=false）', () => {
    const base = query([explicitSpan('https://real.example/y')]);
    const hit = findLinkAtPoint({ ...base, line: 0, col: PLAIN_START });
    expect(hit).toEqual({ kind: 'url', url: 'https://plain.example', explicit: false });
  });

  test('URI 不可打开的标记格：无命中，也不回退到正则', () => {
    for (const uri of ['javascript:alert(1)', '']) {
      const hit = findLinkAtPoint({ ...query([explicitSpan(uri)]), line: 0, col: LABEL_START + 2 });
      expect(hit).toBeNull();
    }
  });

  test('正则匹配只要部分落在 explicit 段内即整体丢弃（点在段外也不命中）', () => {
    const partial: ExplicitLinkSpan = {
      startCol: LABEL_START,
      endCol: LABEL_START + 4,
      uri: 'https://p',
      text: 'https',
    };
    const hit = findLinkAtPoint({ ...query([partial]), line: 0, col: LABEL_END });
    expect(hit).toBeNull();
  });

  test('下划线：explicit 段有效才画，重叠的正则段剔除，其余正则段保留', () => {
    const valid = collectLinkUnderlineSegments({
      ...query([explicitSpan('https://real.example/y')]),
      offset: 0,
      rows: 1,
    });
    expect(valid).toEqual([
      { row: 0, startCol: LABEL_START, endCol: LABEL_END },
      { row: 0, startCol: PLAIN_START, endCol: TEXT.length - 1 },
    ]);

    const invalid = collectLinkUnderlineSegments({
      ...query([explicitSpan('data:text/plain,x')]),
      offset: 0,
      rows: 1,
    });
    expect(invalid).toEqual([{ row: 0, startCol: PLAIN_START, endCol: TEXT.length - 1 }]);
  });

  test('无 explicit 源时行为与之前一致', () => {
    const { explicitLinks: _omit, ...plain } = query([]);
    expect(findLinkAtPoint({ ...plain, line: 0, col: LABEL_START })).toEqual({
      kind: 'url',
      url: 'https://shown.example/x',
      explicit: false,
    });
  });
});
