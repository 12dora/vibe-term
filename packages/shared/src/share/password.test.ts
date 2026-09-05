import { describe, expect, test } from 'bun:test';
import { SHARE_PASSWORD_ALPHABET, generateSharePassword } from './password';
import { SHARE_PASSWORD_MIN_LENGTH } from './types';

describe('generateSharePassword', () => {
  test('默认 8 位，字符全部来自去混淆字母表', () => {
    for (let i = 0; i < 200; i++) {
      const password = generateSharePassword();
      expect(password).toHaveLength(8);
      for (const char of password) expect(SHARE_PASSWORD_ALPHABET).toContain(char);
    }
  });

  test('字母表不含 0O1lI', () => {
    for (const banned of ['0', 'O', '1', 'l', 'I']) {
      expect(SHARE_PASSWORD_ALPHABET).not.toContain(banned);
    }
    expect(SHARE_PASSWORD_ALPHABET).toHaveLength(57);
    expect(new Set(SHARE_PASSWORD_ALPHABET).size).toBe(SHARE_PASSWORD_ALPHABET.length);
  });

  test('长度可指定，低于下限时按下限生成', () => {
    expect(generateSharePassword(24)).toHaveLength(24);
    expect(generateSharePassword(2)).toHaveLength(SHARE_PASSWORD_MIN_LENGTH);
  });

  test('使用 crypto.getRandomValues', () => {
    const original = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    (crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = ((
      array: Uint8Array
    ) => {
      calls += 1;
      return original(array);
    }) as typeof crypto.getRandomValues;
    try {
      generateSharePassword();
    } finally {
      (crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues =
        original as typeof crypto.getRandomValues;
    }
    expect(calls).toBeGreaterThan(0);
  });

  test('随机性：连续生成不重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateSharePassword(12));
    expect(seen.size).toBe(500);
  });
});
