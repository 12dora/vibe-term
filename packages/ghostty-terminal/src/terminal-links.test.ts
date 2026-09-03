// 链接检测的缓存键：改成整段 join 之后必须与逐字符拼接的老实现逐位一致，
// 否则整屏的检测结果缓存会全部落空。
import { describe, expect, test } from 'bun:test';
import type { SelectionLineModel } from './selection-model';
import { LinkMatchCache, cacheKey } from './terminal-links';
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
