// 带「生成」按钮的口令框：生成器的字母表与长度、自动生成的判定、静态版式。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GENERATED_PASSWORD_LENGTH,
  PASSWORD_ALPHABET,
  PasswordFieldWithGenerate,
  generatePassword,
  shouldAutoGenerate,
} from './password-field-with-generate';

const noop = (): void => undefined;

describe('generatePassword', () => {
  test('默认 20 位，全部落在字母表里', () => {
    const value = generatePassword();
    expect(value).toHaveLength(GENERATED_PASSWORD_LENGTH);
    for (const char of value) expect(PASSWORD_ALPHABET).toContain(char);
  });

  test('字母表不含易混字符', () => {
    for (const char of '01lIO') expect(PASSWORD_ALPHABET).not.toContain(char);
  });

  test('可以指定长度', () => {
    expect(generatePassword(32)).toHaveLength(32);
    expect(generatePassword(1)).toHaveLength(1);
  });

  test('每次都不一样', () => {
    const values = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(values.size).toBe(20);
  });
});

describe('shouldAutoGenerate', () => {
  test('只在开了自动生成且字段还空着时生成', () => {
    expect(shouldAutoGenerate(true, '')).toBe(true);
    // 用户手填过的值绝不覆盖。
    expect(shouldAutoGenerate(true, 'my-own-password')).toBe(false);
    expect(shouldAutoGenerate(false, '')).toBe(false);
  });
});

describe('PasswordFieldWithGenerate', () => {
  test('空值：有生成与显示按钮，没有复制按钮', () => {
    const html = renderToStaticMarkup(
      <PasswordFieldWithGenerate id="demo-password" value="" onChange={noop} />
    );
    expect(html).toContain('data-testid="demo-password"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-testid="demo-password-generate"');
    expect(html).toContain('data-testid="demo-password-reveal"');
    expect(html).not.toContain('data-testid="demo-password-copy"');
  });

  test('有值：出现复制按钮', () => {
    const html = renderToStaticMarkup(
      <PasswordFieldWithGenerate id="demo-password" value="abc" onChange={noop} />
    );
    expect(html).toContain('data-testid="demo-password-copy"');
    expect(html).toContain('value="abc"');
  });

  test('可以关掉显示 / 隐藏切换', () => {
    const html = renderToStaticMarkup(
      <PasswordFieldWithGenerate id="demo-password" value="" onChange={noop} revealToggle={false} />
    );
    expect(html).not.toContain('data-testid="demo-password-reveal"');
    expect(html).toContain('data-testid="demo-password-generate"');
  });

  test('禁用时输入与两个按钮一起禁用', () => {
    const html = renderToStaticMarkup(
      <PasswordFieldWithGenerate id="demo-password" value="" onChange={noop} disabled />
    );
    expect(html).toContain('disabled=""');
  });
});
