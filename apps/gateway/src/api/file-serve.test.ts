import { describe, expect, test } from 'bun:test';
import {
  httpDate,
  identityValidators,
  ifRangeAllowsPartial,
  sessionValidators,
  strongEtag,
} from './file-serve';

describe('ifRangeAllowsPartial', () => {
  const validators = {
    etag: strongEtag(['sid', 5, 1000]),
    lastModified: httpDate(1000),
  };

  test('没有 If-Range 时允许 Range', () => {
    expect(ifRangeAllowsPartial(null, validators)).toBe(true);
  });

  test('强 ETag 精确匹配才放行', () => {
    expect(ifRangeAllowsPartial(validators.etag, validators)).toBe(true);
    expect(ifRangeAllowsPartial('"other"', validators)).toBe(false);
    expect(ifRangeAllowsPartial(`W/${validators.etag}`, validators)).toBe(false);
  });

  test('HTTP-date 与 Last-Modified 精确相等才放行', () => {
    expect(ifRangeAllowsPartial(validators.lastModified, validators)).toBe(true);
    expect(ifRangeAllowsPartial('Wed, 21 Oct 2015 07:28:00 GMT', validators)).toBe(false);
  });
});

describe('validators', () => {
  test('下载会话 ETag 含 id / size / mtime', () => {
    const v = sessionValidators({ id: 'abc', size: 12, sourceMtimeMs: 42 });
    expect(v.etag).toBe('"abc:12:42"');
    expect(v.lastModified).toBe(httpDate(42));
  });

  test('raw/download 身份含 size / mtime / inode', () => {
    const v = identityValidators({ size: 3, mtimeMs: 9, ino: 7 });
    expect(v.etag).toBe('"3:9:7"');
    expect(v.lastModified).toBe(httpDate(9));
  });
});
