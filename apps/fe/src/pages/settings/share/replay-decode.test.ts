// 载荷解码与输入标记的渲染。

import { describe, expect, test } from 'bun:test';
import {
  concatBytes,
  decodeBase64,
  describeInputBase64,
  describeInputBytes,
} from './replay-decode';

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe('decodeBase64 / concatBytes', () => {
  test('空串解出空数组', () => {
    expect(decodeBase64('').length).toBe(0);
  });

  test('多字节内容按字节还原', () => {
    const bytes = decodeBase64(b64('你好'));
    expect(new TextDecoder().decode(bytes)).toBe('你好');
  });

  test('拼接保持顺序', () => {
    const merged = concatBytes([decodeBase64(b64('ab')), decodeBase64(b64('cd'))]);
    expect(new TextDecoder().decode(merged)).toBe('abcd');
  });

  test('单片直接返回，不复制', () => {
    const one = decodeBase64(b64('x'));
    expect(concatBytes([one])).toBe(one);
  });
});

describe('describeInputBytes', () => {
  test('可见字符原样出', () => {
    expect(describeInputBase64(b64('ls -al'))).toBe('ls -al');
  });

  test('回车、Tab、退格、Esc 换成记号', () => {
    expect(describeInputBase64(b64('a\r'))).toBe('a⏎');
    expect(describeInputBase64(b64('\t'))).toBe('⇥');
    expect(describeInputBase64(b64('\x7f'))).toBe('⌫');
    expect(describeInputBase64(b64('\x1b[A'))).toBe('⎋[A');
  });

  test('其余控制字符按 ^X', () => {
    expect(describeInputBase64(b64('\x03'))).toBe('^C');
  });

  test('过长的输入截断', () => {
    const text = describeInputBytes(new TextEncoder().encode('x'.repeat(400)));
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(121);
  });
});
