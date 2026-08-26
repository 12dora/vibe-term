import { describe, expect, test } from 'bun:test';
import { buildEditorPayloads } from './use-editor-input';

describe('buildEditorPayloads', () => {
  test('sends the whole draft as one payload with a trailing return', () => {
    expect(buildEditorPayloads('echo hi', 'whole', true)).toEqual(['echo hi\r']);
  });

  test('omits the trailing return when the enter switch is off', () => {
    expect(buildEditorPayloads('echo hi', 'whole', false)).toEqual(['echo hi']);
  });

  test('keeps multi-line drafts intact in whole mode', () => {
    expect(buildEditorPayloads('a\nb', 'whole', false)).toEqual(['a\nb']);
  });

  test('splits line-by-line drafts and always appends a return', () => {
    expect(buildEditorPayloads('a\r\nb\nc', 'line-by-line', false)).toEqual(['a\r', 'b\r', 'c\r']);
  });

  test('skips blank lines in line-by-line mode', () => {
    expect(buildEditorPayloads('a\n\n   \nb', 'line-by-line', true)).toEqual(['a\r', 'b\r']);
  });
});
