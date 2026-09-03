import { describe, expect, test } from 'bun:test';
import {
  GUTTER_BLOCK_LINES,
  countLines,
  gutterBlockText,
  gutterText,
  splitCodeBlocks,
} from './line-gutter';

describe('countLines', () => {
  test('与 split 等价', () => {
    for (const sample of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n\n']) {
      expect(countLines(sample)).toBe(sample.split('\n').length);
    }
  });
});

describe('splitCodeBlocks', () => {
  test('行数守恒且可无损重组', () => {
    for (const sample of ['', 'a', 'a\nb\n', 'x\n'.repeat(1201), 'no-newline']) {
      const blocks = splitCodeBlocks(sample, GUTTER_BLOCK_LINES);
      expect(blocks.reduce((sum, block) => sum + block.lineCount, 0)).toBe(countLines(sample));
      expect(blocks.map((block) => block.text).join('\n')).toBe(sample);
    }
  });

  test('起始行号连续', () => {
    const blocks = splitCodeBlocks('x\n'.repeat(1201), GUTTER_BLOCK_LINES);
    expect(blocks.map((block) => block.startLine)).toEqual([1, 501, 1001]);
    expect(blocks.map((block) => block.lineCount)).toEqual([500, 500, 202]);
  });
});

describe('行号栏', () => {
  test('整栏文本逐行递增', () => {
    expect(gutterText(3)).toBe('1\n2\n3');
    expect(gutterText(1200).split('\n').length).toBe(1200);
    expect(gutterText(1200).split('\n')[1199]).toBe('1200');
  });

  test('整块结果跨调用复用同一字符串', () => {
    const first = gutterBlockText(1, GUTTER_BLOCK_LINES);
    expect(gutterBlockText(1, GUTTER_BLOCK_LINES)).toBe(first);
    // 缓存命中返回的是同一实例（跨文件复用的正是这一点）。
    expect(Object.is(gutterBlockText(1, GUTTER_BLOCK_LINES), first)).toBe(true);
  });
});
