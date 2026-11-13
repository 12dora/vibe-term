import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalFileHandle } from '../files/local-fs';
import { FILE_RESPONSE_CSP } from '../files/safe-file-headers';
import {
  httpDate,
  identityValidators,
  ifRangeAllowsPartial,
  serveFileBytes,
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

  test('本机身份 ETag 为不透明 ASCII，同 inode 相同、不同则变', () => {
    const v = identityValidators({ size: 3, mtimeMs: 9, ino: 7 });
    expect(v.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(v.etag).toBe(identityValidators({ size: 3, mtimeMs: 9, ino: 7 }).etag);
    expect(v.etag).not.toBe(identityValidators({ size: 3, mtimeMs: 9, ino: 8 }).etag);
    expect(v.lastModified).toBe(httpDate(9));
  });

  test('SSH 源身份哈希路径，中文与引号也可作响应头', () => {
    const chinese = identityValidators({ size: 5, mtimeMs: 9, path: '/home/u/中文 文件.mp4' });
    const quoted = identityValidators({ size: 5, mtimeMs: 9, path: '/home/u/a"b.mp4' });
    expect(chinese.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(quoted.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(chinese.etag).not.toBe(quoted.etag);
    expect(chinese.etag).toBe(
      identityValidators({ size: 5, mtimeMs: 9, path: '/home/u/中文 文件.mp4' }).etag
    );
    expect(() => new Headers({ ETag: chinese.etag })).not.toThrow();
    expect(() => new Headers({ ETag: quoted.etag })).not.toThrow();
    expect(chinese.lastModified).toBe(httpDate(9));
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

  test('中文与引号路径的 /raw 与 /download 都能发 ASCII ETag', async () => {
    const source = { size: 5, mtimeMs: 1_700_000_000_000, path: '/home/u/中文 "文件.mp4' };
    const a = copyOf('hello');
    const raw = servePulledFile(
      new Request('http://localhost/api/files/raw'),
      remoteHandle(a.tmpPath, source, true, () => rmSync(a.dir, { recursive: true, force: true })),
      false
    );
    const b = copyOf('hello');
    const download = servePulledFile(
      new Request('http://localhost/api/files/download'),
      remoteHandle(b.tmpPath, source, true, () => rmSync(b.dir, { recursive: true, force: true })),
      true
    );
    expect(raw.status).toBe(200);
    expect(download.status).toBe(200);
    expect(raw.headers.get('ETag')).toBe(identityValidators(source).etag);
    expect(download.headers.get('ETag')).toBe(raw.headers.get('ETag'));
    expect(raw.headers.get('ETag')).toMatch(/^"[0-9a-f]+"$/);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await raw.text()).toBe('hello');
    expect(await download.text()).toBe('hello');
  });

  test('Response 构造失败时回收临时目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-serve-fail-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, 'hello');
    const res = serveFileBytes(new Request('http://localhost/raw'), {
      path: tmpPath,
      name: 'a.bin',
      mime: 'application/octet-stream',
      entityLength: 5,
      validators: { etag: `"5:9:/home/u/中文 文件.mp4"`, lastModified: null },
      attachment: false,
      cleanupAfter: () => rmSync(dir, { recursive: true, force: true }),
    });
    expect(res.status).toBe(500);
    expect(existsSync(dir)).toBe(false);
  });

  test('无 Range 时只发 stat 时的 entityLength，忽略随后增长的字节', async () => {
    const { tmpPath } = copyOf('hello');
    appendFileSync(tmpPath, 'XXXXX');
    const res = serveFileBytes(new Request('http://localhost/raw'), {
      path: tmpPath,
      name: 'a.bin',
      mime: 'application/octet-stream',
      entityLength: 5,
      validators: identityValidators({ size: 5, mtimeMs: 9, ino: 1 }),
      attachment: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(res.headers.get('X-VibeTerm-Entity-Length')).toBe('5');
    expect(await res.text()).toBe('hello');
  });
});

describe('serveFileBytes 安全响应头', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function serve(
    name: string,
    mime: string,
    headers: Record<string, string> = {},
    attachment = false
  ): Response {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-safe-'));
    dirs.push(dir);
    const path = join(dir, name);
    const body = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
    writeFileSync(path, body);
    return serveFileBytes(new Request('http://localhost/api/files/raw', { headers }), {
      path,
      name,
      mime,
      entityLength: Buffer.byteLength(body),
      validators: { etag: '"x"', lastModified: null },
      attachment,
    });
  }

  test('直接打开 .svg 不按 image/svg+xml 内联，带 nosniff 与 sandbox CSP', () => {
    for (const headers of [
      {},
      { 'sec-fetch-dest': 'document' },
      { 'sec-fetch-dest': 'iframe' },
    ] as Record<string, string>[]) {
      const res = serve('x.svg', 'image/svg+xml', headers);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('Content-Disposition')).toStartWith('attachment;');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toBe(FILE_RESPONSE_CSP);
    }
  });

  test('<img> 拉 .svg（Sec-Fetch-Dest: image）按图片内联，仍带 sandbox CSP', () => {
    const res = serve('x.svg', 'image/svg+xml', { 'sec-fetch-dest': 'image' });
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toStartWith('inline;');
    expect(res.headers.get('Content-Security-Policy')).toBe(FILE_RESPONSE_CSP);
    expect(res.headers.get('Vary')).toBe('Sec-Fetch-Dest');
  });

  test('HTML / XML 一律附件下载', () => {
    for (const [name, mime] of [
      ['x.html', 'text/html'],
      ['x.xml', 'application/xml'],
      ['x.xhtml', 'application/xhtml+xml'],
    ] as const) {
      const res = serve(name, mime, { 'sec-fetch-dest': 'image' });
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('Content-Disposition')).toStartWith('attachment;');
    }
  });

  test('PNG / PDF 仍可内联预览；download=1 仍是附件', () => {
    const png = serve('x.png', 'image/png');
    expect(png.headers.get('Content-Type')).toBe('image/png');
    expect(png.headers.get('Content-Disposition')).toStartWith('inline;');
    expect(png.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const pdf = serve('x.pdf', 'application/pdf', { 'sec-fetch-dest': 'iframe' });
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toStartWith('inline;');
    const download = serve('x.png', 'image/png', {}, true);
    expect(download.headers.get('Content-Type')).toBe('image/png');
    expect(download.headers.get('Content-Disposition')).toStartWith('attachment;');
  });
});
