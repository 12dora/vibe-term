import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  CompressedBodyCache,
  compressBytes,
  gzipBytes,
  negotiateEncoding,
  resetCompressionCacheForTests,
  resolveEncodedBody,
  sidecarPath,
  variantEtag,
} from './static-compression';

const tempDirs: string[] = [];

afterEach(async () => {
  resetCompressionCacheForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('negotiateEncoding', () => {
  test('优先 br，其次 gzip，缺省 identity', () => {
    expect(negotiateEncoding('br, gzip')).toBe('br');
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip')).toBe('gzip');
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
    expect(negotiateEncoding('identity')).toBeNull();
    expect(negotiateEncoding('gzip;q=0, br;q=0')).toBeNull();
  });

  test('br 只要 q>0 就优先于 gzip；* 视为可出 br', () => {
    expect(negotiateEncoding('gzip;q=1.0, br;q=0.1')).toBe('br');
    expect(negotiateEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(negotiateEncoding('*')).toBe('br');
    expect(negotiateEncoding('*;q=0')).toBeNull();
  });
});

describe('variantEtag', () => {
  test('identity 保持 size-mtime，压缩变体带编码后缀', () => {
    expect(variantEtag(12, 1000, null)).toBe('W/"12-1000"');
    expect(variantEtag(12, 1000, 'gzip')).toBe('W/"12-1000-gzip"');
    expect(variantEtag(12, 1000, 'br')).toBe('W/"12-1000-br"');
  });
});

describe('compressBytes', () => {
  test('gzip / br 都能还原', () => {
    const raw = Buffer.from(`${'hello world\n'.repeat(50)}`);
    expect(gunzipSync(Buffer.from(gzipBytes(raw))).equals(raw)).toBe(true);
    expect(brotliDecompressSync(Buffer.from(compressBytes(raw, 'br'))).equals(raw)).toBe(true);
  });
});

describe('CompressedBodyCache', () => {
  test('超过容量时按 LRU 淘汰', () => {
    const cache = new CompressedBodyCache(8);
    cache.set('a', Buffer.from('aaaa'));
    cache.set('b', Buffer.from('bbbb'));
    expect(cache.size).toBe(2);
    cache.get('a');
    cache.set('c', Buffer.from('cccc'));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.byteLength).toBe(4);
    expect(cache.get('c')?.byteLength).toBe(4);
  });
});

describe('resolveEncodedBody', () => {
  test('sidecar 路径按编码加后缀', () => {
    expect(sidecarPath('/x/a.js', 'gzip')).toBe('/x/a.js.gz');
    expect(sidecarPath('/x/a.js', 'br')).toBe('/x/a.js.br');
  });

  test('已有 sidecar 时不再即时压缩', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-enc-'));
    tempDirs.push(root);
    await mkdir(join(root, 'assets'), { recursive: true });
    const file = join(root, 'assets', 'a.js');
    await writeFile(file, `${'hello\n'.repeat(40)}`);
    await writeFile(`${file}.gz`, 'prebuilt');
    const body = resolveEncodedBody(file, 'gzip');
    expect(body.encoding).toBe('gzip');
    expect(body.filePath).toBe(`${file}.gz`);
    expect(body.bytes).toBeUndefined();
  });
});
