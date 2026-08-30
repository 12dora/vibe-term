import { describe, expect, test } from 'bun:test';
import { jsonText } from './json-text';

describe('jsonText', () => {
  test('已经是 JSON 的字符串原样返回', () => {
    expect(jsonText('{"a":1}')).toBe('{"a":1}');
    expect(jsonText('[1,2]')).toBe('[1,2]');
  });

  test('非 JSON 字符串会再 stringify', () => {
    expect(jsonText('not-json')).toBe('"not-json"');
  });

  test('对象与缺省值', () => {
    expect(jsonText({ a: 1 })).toBe('{"a":1}');
    expect(jsonText(null)).toBe('null');
    expect(jsonText(undefined)).toBe('null');
  });
});
