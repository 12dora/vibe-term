import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalFileHandle } from '../files/local-fs';
import {
  httpDate,
  identityValidators,
  ifRangeAllowsPartial,
  servePulledFile,
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

  test('日期或弱 ETag 的 If-Range 不放行 Range', () => {
    expect(ifRangeAllowsPartial(validators.lastModified, validators)).toBe(false);
    expect(ifRangeAllowsPartial('Wed, 21 Oct 2015 07:28:00 GMT', validators)).toBe(false);
    expect(ifRangeAllowsPartial(`W/${validators.etag}`, validators)).toBe(false);
  });
});

describe('validators', () => {
  test('下载会话 ETag 含 id / size / mtime', () => {
    const v = sessionValidators({ id: 'abc', size: 12, sourceMtimeMs: 42 });
    expect(v.etag).toBe('"abc:12:42"');
    expect(v.lastModified).toBe(httpDate(42));
  });

  test('本机身份含 size / mtime / inode', () => {
    const v = identityValidators({ size: 3, mtimeMs: 9, ino: 7 });
    expect(v.etag).toBe('"3:9:7"');
    expect(v.lastModified).toBe(httpDate(9));
  });

  test('SSH 源身份含 size / mtime / 规范化路径，不用 inode', () => {
    const v = identityValidators({ size: 5, mtimeMs: 9, path: '/data/a.bin' });
    expect(v.etag).toBe('"5:9:/data/a.bin"');
    expect(v.lastModified).toBe(httpDate(9));
  });
});

describe('servePulledFile 源身份与临时副本', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function copyOf(bytes: string): { dir: string; tmpPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-serve-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, bytes);
    return { dir, tmpPath };
  }

  function remoteHandle(
    tmpPath: string,
    source: { size: number; mtimeMs: number; path: string },
    temporary: boolean,
    cleanup: () => void
  ): LocalFileHandle {
    return {
      tmpPath,
      size: 5,
      name: 'a.bin',
      mime: 'application/octet-stream',
      temporary,
      cleanup,
      source,
    };
  }

  test('两次拉取同一未变 SSH 源得到相同 ETag；源变更则不同', async () => {
    const a = copyOf('hello');
    const b = copyOf('hello');
    const source = { size: 5, mtimeMs: 1_700_000_000_000, path: '/data/a.bin' };
    const resA = servePulledFile(
      new Request('http://localhost/raw'),
      remoteHandle(a.tmpPath, source, true, () => rmSync(a.dir, { recursive: true, force: true })),
      false
    );
    const resB = servePulledFile(
      new Request('http://localhost/raw'),
      remoteHandle(b.tmpPath, source, true, () => rmSync(b.dir, { recursive: true, force: true })),
      false
    );
    expect(resA.headers.get('ETag')).toBe(identityValidators(source).etag);
    expect(resA.headers.get('ETag')).toBe(resB.headers.get('ETag'));
    expect(resA.headers.get('Last-Modified')).toBe(resB.headers.get('Last-Modified'));
    expect(await resA.text()).toBe('hello');
    expect(await resB.text()).toBe('hello');

    const changed = { ...source, mtimeMs: source.mtimeMs + 1000 };
    const c = copyOf('hello');
    const resC = servePulledFile(
      new Request('http://localhost/raw'),
      remoteHandle(c.tmpPath, changed, true, () => {}),
      false
    );
    expect(resC.headers.get('ETag')).not.toBe(resA.headers.get('ETag'));
  });

  test('本机文件 temporary=false 走实体长度且不删除源文件', async () => {
    const { tmpPath } = copyOf('hello');
    const res = servePulledFile(
      new Request('http://localhost/raw'),
      {
        tmpPath,
        size: 5,
        name: 'a.bin',
        mime: 'application/octet-stream',
        temporary: false,
        cleanup: () => rmSync(tmpPath, { force: true }),
        source: { size: 5, mtimeMs: 9, ino: 1 },
      },
      false
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(await res.text()).toBe('hello');
    expect(existsSync(tmpPath)).toBe(true);
  });

  test('If-Range 日期忽略 Range，发 200 全文', async () => {
    const { tmpPath } = copyOf('hello');
    const source = { size: 5, mtimeMs: 1_700_000_000_000, path: '/data/a.bin' };
    const res = servePulledFile(
      new Request('http://localhost/raw', {
        headers: { Range: 'bytes=0-1', 'If-Range': httpDate(source.mtimeMs) },
      }),
      remoteHandle(tmpPath, source, false, () => {}),
      false
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });
});
