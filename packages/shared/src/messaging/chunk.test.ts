import { describe, expect, test } from 'bun:test';
import { chunkText } from './chunk';

describe('chunkText', () => {
  test('returns empty array for empty text', () => {
    expect(chunkText('', 10)).toEqual([]);
  });

  test('returns the original string when it fits', () => {
    expect(chunkText('hello', 10)).toEqual(['hello']);
  });

  test('packs whole lines before splitting', () => {
    expect(chunkText('aa\nbb\ncc', 5)).toEqual(['aa\nbb', 'cc']);
  });

  test('hard-splits a line longer than maxChars', () => {
    expect(chunkText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('does not split a UTF-16 surrogate pair', () => {
    const emoji = '😀';
    expect(emoji.length).toBe(2);
    const text = `xx${emoji}yy`;
    const chunks = chunkText(text, 3);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(() => [...chunk]).not.toThrow();
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  test('keeps a trailing empty line as a blank join', () => {
    expect(chunkText('a\n\nb', 10)).toEqual(['a\n\nb']);
  });

  test('rejects non-positive maxChars', () => {
    expect(() => chunkText('a', 0)).toThrow();
  });
});
