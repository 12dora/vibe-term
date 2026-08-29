// 一次性验证码输入的编辑语义：值始终是一串纯数字，格子只是它的可视切分。
// 无 DOM 测试环境，交互逻辑全部拆成纯函数在这里覆盖；渲染结构由 react-dom/server 静态渲染验证。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  OtpInput,
  applyOtpBackspace,
  applyOtpDelete,
  applyOtpInsert,
  clampOtpIndex,
  extractOtpInput,
  moveOtpIndex,
  sanitizeOtp,
} from './otp-input';

describe('sanitizeOtp', () => {
  test('只保留数字并按长度截断', () => {
    expect(sanitizeOtp('12 34-56')).toBe('123456');
    expect(sanitizeOtp('a1b2c3')).toBe('123');
    expect(sanitizeOtp('1234567890')).toBe('123456');
    expect(sanitizeOtp('1234567890', 8)).toBe('12345678');
    expect(sanitizeOtp('abc')).toBe('');
  });
});

describe('clampOtpIndex / moveOtpIndex', () => {
  test('空码只能停在第一格', () => {
    expect(clampOtpIndex('', 0)).toBe(0);
    expect(clampOtpIndex('', 3)).toBe(0);
    expect(clampOtpIndex('', -2)).toBe(0);
  });

  test('已填 n 位时最远能停到第 n 格（第一个空格子）', () => {
    expect(clampOtpIndex('12', 2)).toBe(2);
    expect(clampOtpIndex('12', 5)).toBe(2);
  });

  test('填满后最远停在最后一格，不会越界', () => {
    expect(clampOtpIndex('123456', 5)).toBe(5);
    expect(clampOtpIndex('123456', 9)).toBe(5);
  });

  test('左右移动受同一套边界约束', () => {
    expect(moveOtpIndex('123', 1, 1)).toBe(2);
    expect(moveOtpIndex('123', 3, 1)).toBe(3);
    expect(moveOtpIndex('123', 0, -1)).toBe(0);
    expect(moveOtpIndex('123456', 4, 1)).toBe(5);
  });
});

describe('applyOtpInsert', () => {
  test('逐位键入自动右移光标', () => {
    expect(applyOtpInsert('', 0, '1')).toEqual({ value: '1', caret: 1 });
    expect(applyOtpInsert('1', 1, '2')).toEqual({ value: '12', caret: 2 });
  });

  test('在已填位上键入是覆盖而不是插入', () => {
    expect(applyOtpInsert('123456', 1, '9')).toEqual({ value: '193456', caret: 2 });
  });

  test('填满后光标停在最后一格', () => {
    expect(applyOtpInsert('12345', 5, '6')).toEqual({ value: '123456', caret: 5 });
  });

  test('非数字直接拒绝，值与光标都不变', () => {
    expect(applyOtpInsert('12', 2, 'a')).toEqual({ value: '12', caret: 2 });
    expect(applyOtpInsert('12', 2, '')).toEqual({ value: '12', caret: 2 });
  });

  test('整串粘贴从当前格开始填，容忍空格与连字符', () => {
    expect(applyOtpInsert('', 0, '123 456')).toEqual({ value: '123456', caret: 5 });
    expect(applyOtpInsert('', 0, '12-34-56')).toEqual({ value: '123456', caret: 5 });
  });

  test('从中间粘贴只覆盖后面的位，超长部分截断', () => {
    expect(applyOtpInsert('12', 2, '9876')).toEqual({ value: '129876', caret: 5 });
    expect(applyOtpInsert('123456', 4, '987654')).toEqual({ value: '123498', caret: 5 });
  });

  test('下标越界时先夹回可聚焦范围，不会填出空洞', () => {
    expect(applyOtpInsert('1', 4, '7')).toEqual({ value: '17', caret: 2 });
  });
});

describe('applyOtpBackspace', () => {
  test('当前格有值时删当前格，光标不动', () => {
    expect(applyOtpBackspace('123456', 2)).toEqual({ value: '12456', caret: 2 });
  });

  test('当前格为空时退到前一格并清掉它', () => {
    expect(applyOtpBackspace('123', 3)).toEqual({ value: '12', caret: 2 });
  });

  test('第一格且为空时什么都不做', () => {
    expect(applyOtpBackspace('', 0)).toEqual({ value: '', caret: 0 });
  });
});

describe('applyOtpDelete', () => {
  test('删当前格，光标留在原处', () => {
    expect(applyOtpDelete('123456', 0)).toEqual({ value: '23456', caret: 0 });
  });

  test('当前格本来就空则无操作', () => {
    expect(applyOtpDelete('12', 2)).toEqual({ value: '12', caret: 2 });
  });
});

describe('extractOtpInput', () => {
  test('光标在末尾时取尾部新增的字符', () => {
    expect(extractOtpInput('19', '1')).toBe('9');
  });

  test('光标在开头时取头部新增的字符', () => {
    expect(extractOtpInput('91', '1')).toBe('9');
  });

  test('原格为空、整串自动填充或被整体替换时按原样返回', () => {
    expect(extractOtpInput('9', '')).toBe('9');
    // 自动填充把整串塞进已有一位的格子：不能当成「多敲了一位」去截
    expect(extractOtpInput('123456', '1')).toBe('123456');
    expect(extractOtpInput('', '1')).toBe('');
    expect(extractOtpInput('9', '1')).toBe('9');
  });
});

describe('OtpInput 渲染', () => {
  test('渲染 length 个单字符格子，testid 逐个编号', () => {
    const html = renderToStaticMarkup(
      <OtpInput value="12" onChange={() => undefined} data-testid="security-totp-code" />
    );
    expect(html).toContain('data-testid="security-totp-code"');
    for (let i = 0; i < 6; i += 1) {
      expect(html).toContain(`data-testid="security-totp-code-${i}"`);
    }
    expect(html).not.toContain('data-testid="security-totp-code-6"');
  });

  test('数字键盘 + 一次性验证码自动填充（只在第一格声明）', () => {
    const html = renderToStaticMarkup(<OtpInput value="" onChange={() => undefined} />);
    expect(html).toContain('inputMode="numeric"');
    expect(html.match(/autoComplete="one-time-code"/g)?.length).toBe(1);
  });

  test('值按位切分到各格，多余的位不渲染', () => {
    const html = renderToStaticMarkup(
      <OtpInput value="1a2b3" onChange={() => undefined} data-testid="otp" />
    );
    expect(html.match(/value="\d"/g)).toEqual(['value="1"', 'value="2"', 'value="3"']);
  });

  test('length 可调', () => {
    const html = renderToStaticMarkup(
      <OtpInput value="" onChange={() => undefined} length={4} data-testid="otp" />
    );
    expect(html).toContain('data-testid="otp-3"');
    expect(html).not.toContain('data-testid="otp-4"');
  });
});
