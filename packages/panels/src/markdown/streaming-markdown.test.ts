import { describe, expect, test } from 'bun:test';

import {
  EMPTY_MARKDOWN_SPLIT,
  advanceMarkdownSplit,
  splitMarkdownBlocks,
} from './streaming-markdown';

/** 参考实现：一次性逐行扫描，作为增量分块的对照 */
function referenceSplit(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const push = (): void => {
    const block = current.join('\n');
    if (block.trim()) blocks.push(block);
    current = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      push();
      continue;
    }
    current.push(line);
  }
  push();
  return blocks;
}

const LINES = [
  'hello world',
  '',
  '  ',
  '```',
  '```ts',
  '~~~',
  'const a = 1;',
  '- item',
  '',
  '# title',
  '| a | b |',
  'tail',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('splitMarkdownBlocks', () => {
  test('围栏外空行分块，围栏内空行不分块', () => {
    expect(splitMarkdownBlocks('a\n\nb')).toEqual(['a', 'b']);
    expect(splitMarkdownBlocks('```\na\n\nb\n```')).toEqual(['```\na\n\nb\n```']);
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('a\n\n\n  \nb\n')).toEqual(['a', 'b']);
  });

  test('与参考实现一致', () => {
    for (const text of ['a\n\nb', '```\n\n```', '  \n\na', 'a\n  ', '~~~\ncode\n~~~\n\nx']) {
      expect(splitMarkdownBlocks(text)).toEqual(referenceSplit(text));
    }
  });
});

describe('advanceMarkdownSplit', () => {
  test('随机追加的增量结果等于全量分块', () => {
    const rand = mulberry32(20260831);
    for (let doc = 0; doc < 60; doc += 1) {
      const lines: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        lines.push(LINES[Math.floor(rand() * LINES.length)] as string);
      }
      const full = lines.join('\n');

      let split = EMPTY_MARKDOWN_SPLIT;
      let cursor = 0;
      while (cursor < full.length) {
        cursor = Math.min(full.length, cursor + 1 + Math.floor(rand() * 7));
        const prefix = full.slice(0, cursor);
        split = advanceMarkdownSplit(split, prefix);
        expect(split.blocks).toEqual(referenceSplit(prefix));
      }
    }
  });

  test('非前缀输入退回全量扫描', () => {
    const first = advanceMarkdownSplit(EMPTY_MARKDOWN_SPLIT, 'a\n\nb\n\nc');
    expect(first.blocks).toEqual(['a', 'b', 'c']);
    const reset = advanceMarkdownSplit(first, 'x\n\ny');
    expect(reset.blocks).toEqual(['x', 'y']);
  });

  test('重复传入同一文本结果不变（幂等）', () => {
    const once = advanceMarkdownSplit(EMPTY_MARKDOWN_SPLIT, 'a\n\nb\n');
    const twice = advanceMarkdownSplit(once, 'a\n\nb\n');
    expect(twice.blocks).toEqual(once.blocks);
  });

  test('已封口块保持同一字符串值，供块级 memo 命中', () => {
    const a = advanceMarkdownSplit(EMPTY_MARKDOWN_SPLIT, 'first\n\nsec');
    const b = advanceMarkdownSplit(a, 'first\n\nsecond');
    expect(b.blocks[0]).toBe(a.blocks[0] as string);
    expect(b.sealed).toBe(a.sealed);
  });
});
