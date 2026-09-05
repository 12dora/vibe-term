import { describe, expect, test } from 'bun:test';
import { errorMessage } from './errors';

describe('errorMessage', () => {
  test('takes the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  test('stringifies everything else', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(404)).toBe('404');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ code: 1 })).toBe('[object Object]');
  });
});
