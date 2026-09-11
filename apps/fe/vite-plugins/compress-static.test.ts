import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compressDistDir, shouldCompressPath, writeCompressionSidecars } from './compress-static';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shouldCompressPath', () => {
  test('可压文本 / wasm，跳过 woff2、png 与已是 sidecar 的文件', () => {
    expect(shouldCompressPath('assets/index.js')).toBe(true);
    expect(shouldCompressPath('assets/app.wasm')).toBe(true);
    expect(shouldCompressPath('index.html')).toBe(true);
    expect(shouldCompressPath('assets/index.js.map')).toBe(false);
    expect(shouldCompressPath('fonts/a.woff2')).toBe(false);
    expect(shouldCompressPath('logo.png')).toBe(false);
    expect(shouldCompressPath('assets/index.js.gz')).toBe(false);
    expect(shouldCompressPath('assets/index.js.br')).toBe(false);
  });
});

describe('writeCompressionSidecars', () => {
  test('为可压文件写出可还原的 .gz / .br', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-sidecar-'));
    tempDirs.push(root);
    const file = join(root, 'index.js');
    const source = `${'export const x = 1;\n'.repeat(40)}`;
    await writeFile(file, source);
    const sizes = writeCompressionSidecars(file);
    expect(sizes.gzip).toBeLessThan(sizes.raw);
    expect(sizes.br).toBeLessThan(sizes.raw);
    expect(existsSync(`${file}.gz`)).toBe(true);
    expect(existsSync(`${file}.br`)).toBe(true);
    expect(gunzipSync(Buffer.from(await Bun.file(`${file}.gz`).arrayBuffer())).toString()).toBe(
      source
    );
    expect(
      brotliDecompressSync(Buffer.from(await Bun.file(`${file}.br`).arrayBuffer())).toString()
    ).toBe(source);
  });

  test('walk dist 时跳过 woff2，并压缩 html/js', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibeterm-dist-'));
    tempDirs.push(root);
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), `<html>${'x'.repeat(200)}</html>`);
    await writeFile(join(root, 'assets', 'a.js'), `${'console.log(1);\n'.repeat(40)}`);
    await writeFile(join(root, 'font.woff2'), 'woff2-bytes');
    const result = compressDistDir(root);
    expect(result.files).toBe(2);
    expect(existsSync(join(root, 'index.html.gz'))).toBe(true);
    expect(existsSync(join(root, 'assets', 'a.js.br'))).toBe(true);
    expect(existsSync(join(root, 'font.woff2.gz'))).toBe(false);
  });
});
