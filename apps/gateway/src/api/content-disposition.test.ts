import { describe, expect, test } from 'bun:test';
import {
  contentDisposition,
  sanitizeContentDisposition,
  sanitizeFilename,
} from './content-disposition';

describe('contentDisposition', () => {
  test('ASCII 名字同时写出 filename 与 filename*', () => {
    expect(contentDisposition('x.tar.gz')).toBe(
      `attachment; filename="x.tar.gz"; filename*=UTF-8''x.tar.gz`
    );
  });

  test('非 ASCII 在 filename= 里换成 _，完整名字放 filename*', () => {
    const value = contentDisposition('报告 "q".txt');
    expect(value).toMatch(/^attachment; filename="[ -~]*"; filename\*=UTF-8''\S+$/);
    const encoded = value.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded ?? '')).toBe('报告 "q".txt');
    expect(value).toContain('filename="__ _q_.txt"');
  });
});

describe('sanitizeFilename', () => {
  test('去掉路径分隔、控制字符和引号', () => {
    expect(sanitizeFilename('../../x.tar.gz')).toBe('....x.tar.gz');
    expect(sanitizeFilename('a"b\r\nc')).toBe('abc');
  });

  test('去掉双向控制符，避免伪装扩展名', () => {
    expect(sanitizeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFilename('a\u202A\u202B\u202C\u202D\u202Eb')).toBe('ab');
    expect(sanitizeFilename('a\u2066\u2067\u2068\u2069b')).toBe('ab');
    expect(sanitizeFilename('a\u200E\u200F\u061Cb')).toBe('ab');
  });
});

describe('sanitizeContentDisposition', () => {
  test('强制 attachment 且无文件名 → 裸 attachment', () => {
    expect(sanitizeContentDisposition(null, true)).toBe('attachment');
    expect(sanitizeContentDisposition('inline', true)).toBe('attachment');
  });

  test('允许的 MIME 且无头 → 不写 disposition', () => {
    expect(sanitizeContentDisposition(null, false)).toBeNull();
    expect(sanitizeContentDisposition('inline', false)).toBe('inline');
  });

  test('filename* 优先于 filename，UTF-8 百分号解码', () => {
    const header = 'attachment; filename="__.tar.gz"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.tar.gz';
    const safe = sanitizeContentDisposition(header, true);
    expect(safe).toBe(contentDisposition('报告.tar.gz'));
    expect(decodeURIComponent(safe?.split("filename*=UTF-8''")[1] ?? '')).toBe('报告.tar.gz');
  });

  test('注入用的 CRLF / 路径不会进入输出头', () => {
    const injected = 'attachment; filename="evil\r\nX-Injected: 1.txt"';
    const safe = sanitizeContentDisposition(injected, true) ?? '';
    expect(safe).not.toMatch(/[\r\n]/);
    expect(safe).toBe(contentDisposition('evilX-Injected: 1.txt'));
    expect(sanitizeContentDisposition('attachment; filename="../../x.tar.gz"', true)).toBe(
      contentDisposition('....x.tar.gz')
    );
  });

  test('filename* 百分号解码出的 CRLF 被剥掉后再编码', () => {
    const header = "attachment; filename*=UTF-8''%0d%0aSet-Cookie%3A%20a=b.tar.gz";
    const safe = sanitizeContentDisposition(header, true) ?? '';
    expect(safe).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(safe.split("filename*=UTF-8''")[1] ?? '')).toBe(
      'Set-Cookie: a=b.tar.gz'
    );
  });
});
