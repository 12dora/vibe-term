// 链接里的密码：拼进去与读出来必须严格互逆，否则被分享人拿到的是一个填错密码的表单。

import { describe, expect, test } from 'bun:test';
import { buildShareLinkWithPassword, readPasswordFromHash } from './share-link-password';

describe('buildShareLinkWithPassword', () => {
  test('密码拼在 fragment 里', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', 'Ab3dEf7h')).toBe(
      'https://a.example/s/s1#p=Ab3dEf7h'
    );
  });

  test('转义 fragment 与 query 分隔符，密码里的 & # + 空格不会拼坏链接', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', 'a&b#c d+e')).toBe(
      'https://a.example/s/s1#p=a%26b%23c%20d%2Be'
    );
  });

  test('覆盖原有 fragment，不叠加', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1#p=old', 'new')).toBe(
      'https://a.example/s/s1#p=new'
    );
  });

  test('空密码原样返回', () => {
    expect(buildShareLinkWithPassword('https://a.example/s/s1', '')).toBe('https://a.example/s/s1');
  });
});

describe('readPasswordFromHash', () => {
  test('读出 #p=，带不带 # 前缀都认', () => {
    expect(readPasswordFromHash('#p=Ab3dEf7h')).toBe('Ab3dEf7h');
    expect(readPasswordFromHash('p=Ab3dEf7h')).toBe('Ab3dEf7h');
  });

  test('与其它 fragment 参数共存时仍能取到', () => {
    expect(readPasswordFromHash('#x=1&p=Ab3dEf7h')).toBe('Ab3dEf7h');
    expect(readPasswordFromHash('#p=Ab3dEf7h&x=1')).toBe('Ab3dEf7h');
  });

  test('解码回原文，`+` 不被当成空格', () => {
    expect(readPasswordFromHash('#p=a%26b%23c%20d%2Be')).toBe('a&b#c d+e');
  });

  test('没有密码、空值或坏转义都返回 null', () => {
    expect(readPasswordFromHash('')).toBeNull();
    expect(readPasswordFromHash('#')).toBeNull();
    expect(readPasswordFromHash('#x=1')).toBeNull();
    expect(readPasswordFromHash('#p=')).toBeNull();
    expect(readPasswordFromHash('#p=%E0%A4%A')).toBeNull();
    // 前缀相同但不是 `p` 的参数不能误命中
    expect(readPasswordFromHash('#pw=secret')).toBeNull();
  });

  test('与拼装严格互逆', () => {
    for (const password of ['Ab3dEf7h', 'a b', '中文密码', '%%%', 'a&b=c#d']) {
      const url = buildShareLinkWithPassword('https://a.example/s/s1', password);
      expect(readPasswordFromHash(url.slice(url.indexOf('#')))).toBe(password);
    }
  });
});
