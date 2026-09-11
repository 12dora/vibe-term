import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { resolveRequestedFile, serveFrontend } from './serve-frontend';
import { resetCompressionCacheForTests } from './static-compression';

const tempDirs: string[] = [];
const HASHED_JS = 'index-a1b2c3d4.js';
const HASHED_JS_BODY = `${'console.log(1);\n'.repeat(40)}`;
const INDEX_HTML = `<html><body>${'ok'.repeat(80)}</body></html>`;
const WASM_BODY = `${'wasm-placeholder\n'.repeat(40)}`;

afterEach(async () => {
  resetCompressionCacheForTests();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await chmod(join(dir, 'assets'), 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    })
  );
});

async function makeStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibeterm-fe-'));
  tempDirs.push(root);
  await writeFile(join(root, 'index.html'), INDEX_HTML);
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', HASHED_JS), HASHED_JS_BODY);
  await writeFile(join(root, 'assets', 'vendor.min-a_b2-3d4E.js'), HASHED_JS_BODY);
  await writeFile(join(root, 'assets', 'ghostty-vt-a1b2c3d4.wasm'), WASM_BODY);
  await mkdir(join(root, 'fonts'), { recursive: true });
  await writeFile(join(root, 'fonts', 'GeistMonoNerdFontMono-Regular.woff2'), 'woff2');
  await writeFile(join(root, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  return root;
}

function req(path: string, headers?: Record<string, string>, method = 'GET'): Request {
  return new Request(`http://127.0.0.1${path}`, { method, headers });
}

describe('resolveRequestedFile', () => {
  test('returns null for malformed percent-encoding', async () => {
    const root = await makeStaticRoot();
    expect(resolveRequestedFile(root, '/%ZZ')).toBeNull();
    expect(resolveRequestedFile(root, '/%E0%A4%A')).toBeNull();
    expect(resolveRequestedFile(root, '/%')).toBeNull();
  });

  test('returns null for path traversal', async () => {
    const root = await makeStaticRoot();
    expect(resolveRequestedFile(root, '../../../../etc/passwd')).toBeNull();
  });
});

describe('serveFrontend', () => {
  test('answers 400 for malformed percent-encoding', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/%ZZ'), root);
    expect(response.status).toBe(400);
  });

  test('sends immutable Cache-Control for hashed Vite assets', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req(`/assets/${HASHED_JS}`), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe(HASHED_JS_BODY);
  });

  test('treats base64url hashes with _ and - as immutable assets', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/assets/vendor.min-a_b2-3d4E.js'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('sends no-cache plus ETag and Last-Modified for index.html', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/index.html'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('ETag')).toMatch(/^W\/"\d+-\d+"$/);
    expect(response.headers.get('Last-Modified')).toBeTruthy();
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test('returns 304 when If-None-Match matches the ETag', async () => {
    const root = await makeStaticRoot();
    const first = await serveFrontend(req('/index.html'), root);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const again = await serveFrontend(req('/index.html', { 'If-None-Match': etag! }), root);
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(etag);
    expect(again.headers.get('Cache-Control')).toBe('no-cache');
    expect(await again.text()).toBe('');
  });

  test('returns 304 when If-Modified-Since matches Last-Modified', async () => {
    const root = await makeStaticRoot();
    const first = await serveFrontend(req('/fonts/GeistMonoNerdFontMono-Regular.woff2'), root);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-cache');
    const lastModified = first.headers.get('Last-Modified');
    expect(lastModified).toBeTruthy();
    await first.arrayBuffer();

    const again = await serveFrontend(
      req('/fonts/GeistMonoNerdFontMono-Regular.woff2', {
        'If-Modified-Since': lastModified!,
      }),
      root
    );
    expect(again.status).toBe(304);
  });
});

describe('service worker 与 wasm 的下发口径', () => {
  test('/sw.js 走根作用域、no-cache、JS MIME（作用域外或缓存住都会让更新卡死）', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/sw.js'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toContain('text/javascript');
    expect(response.headers.get('ETag')).toMatch(/^W\/"\d+-\d+"$/);
    expect(await response.text()).toContain('addEventListener');
  });

  test('缺 sw.js 时 404 而不是 SPA fallback 成 index.html', async () => {
    const root = await makeStaticRoot();
    await rm(join(root, 'sw.js'));
    const response = await serveFrontend(req('/sw.js'), root);
    expect(response.status).toBe(404);
  });

  test('.wasm 下发 application/wasm，instantiateStreaming 才认', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/assets/ghostty-vt-a1b2c3d4.wasm'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/wasm');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('woff2 下发 font/woff2', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/fonts/GeistMonoNerdFontMono-Regular.woff2'), root);
    expect(response.headers.get('Content-Type')).toBe('font/woff2');
  });
});

describe('SPA fallback', () => {
  test('/s/:id 与 /n/:node/s/:id 与 /n/:node/devices 一样回 index.html', async () => {
    const root = await makeStaticRoot();
    for (const path of [
      '/devices',
      '/n/aabbccddeeff00112233445566778899/devices',
      '/s/AbCd1234',
      '/n/aabbccddeeff00112233445566778899/s/AbCd1234',
    ]) {
      const res = await serveFrontend(req(path), root);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });
});

describe('静态资源压缩', () => {
  test('Accept-Encoding: br, gzip 优先 br，且 Content-Length 对得上', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'br, gzip' }),
      root
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBe('br');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(response.headers.get('Content-Type')).toContain('text/javascript');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(bytes.byteLength).toBeLessThan(HASHED_JS_BODY.length);
    expect(brotliDecompressSync(bytes).toString()).toBe(HASHED_JS_BODY);
  });

  test('只声明 gzip 时走 gzip', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(gunzipSync(bytes).toString()).toBe(HASHED_JS_BODY);
  });

  test('未声明 Accept-Encoding 或 identity 时回落原文', async () => {
    const root = await makeStaticRoot();
    const cases: Array<Record<string, string> | undefined> = [
      undefined,
      { 'Accept-Encoding': 'identity' },
      { 'Accept-Encoding': 'gzip;q=0, br;q=0' },
    ];
    for (const headers of cases) {
      const response = await serveFrontend(req(`/assets/${HASHED_JS}`, headers), root);
      expect(response.headers.get('Content-Encoding')).toBeNull();
      expect(await response.text()).toBe(HASHED_JS_BODY);
    }
  });

  test('ETag 按编码变体区分，304 只命中同一变体', async () => {
    const root = await makeStaticRoot();
    const identity = await serveFrontend(req(`/assets/${HASHED_JS}`), root);
    const gzip = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    const br = await serveFrontend(req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'br' }), root);
    const identityEtag = identity.headers.get('ETag');
    const gzipEtag = gzip.headers.get('ETag');
    const brEtag = br.headers.get('ETag');
    expect(identityEtag).toBeTruthy();
    expect(gzipEtag).toBeTruthy();
    expect(brEtag).toBeTruthy();
    expect(identityEtag).not.toBe(gzipEtag);
    expect(gzipEtag).not.toBe(brEtag);
    expect(identityEtag).not.toBe(brEtag);
    await Promise.all([identity.arrayBuffer(), gzip.arrayBuffer(), br.arrayBuffer()]);

    const gzip304 = await serveFrontend(
      req(`/assets/${HASHED_JS}`, {
        'Accept-Encoding': 'gzip',
        'If-None-Match': gzipEtag!,
      }),
      root
    );
    expect(gzip304.status).toBe(304);
    expect(gzip304.headers.get('ETag')).toBe(gzipEtag);
    expect(gzip304.headers.get('Content-Encoding')).toBe('gzip');
    expect(gzip304.headers.get('Vary')).toBe('Accept-Encoding');

    const crossed = await serveFrontend(
      req(`/assets/${HASHED_JS}`, {
        'Accept-Encoding': 'gzip',
        'If-None-Match': identityEtag!,
      }),
      root
    );
    expect(crossed.status).toBe(200);
    expect(crossed.headers.get('Content-Encoding')).toBe('gzip');
  });

  test('index.html 仍是 no-cache，但可以压缩', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(req('/index.html', { 'Accept-Encoding': 'gzip' }), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(INDEX_HTML);
  });

  test('woff2 / png 等不可压类型原样下发，不带 Content-Encoding 与 Vary', async () => {
    const root = await makeStaticRoot();
    await writeFile(join(root, 'logo.png'), 'png-bytes');
    for (const path of ['/fonts/GeistMonoNerdFontMono-Regular.woff2', '/logo.png']) {
      const response = await serveFrontend(req(path, { 'Accept-Encoding': 'br, gzip' }), root);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Encoding')).toBeNull();
      expect(response.headers.get('Vary')).toBeNull();
    }
  });

  test('.wasm 压缩后仍是 application/wasm', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      req('/assets/ghostty-vt-a1b2c3d4.wasm', { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(response.headers.get('Content-Type')).toBe('application/wasm');
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(WASM_BODY);
  });

  test('Range 请求绕过压缩', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      req(`/assets/${HASHED_JS}`, {
        'Accept-Encoding': 'br, gzip',
        Range: 'bytes=0-10',
      }),
      root
    );
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(await response.text()).toBe(HASHED_JS_BODY);
  });

  test('构建期 sidecar 优先于即时压缩', async () => {
    const root = await makeStaticRoot();
    const sidecar = 'SIDECAR_GZIP_BYTES_NOT_FROM_RUNTIME';
    await writeFile(join(root, 'assets', `${HASHED_JS}.gz`), sidecar);
    const response = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(await response.text()).toBe(sidecar);
  });

  test('没有 sidecar 时即时压缩并原子落盘 .gz/.br', async () => {
    const root = await makeStaticRoot();
    const gzPath = join(root, 'assets', `${HASHED_JS}.gz`);
    const brPath = join(root, 'assets', `${HASHED_JS}.br`);
    expect(existsSync(gzPath)).toBe(false);
    expect(existsSync(brPath)).toBe(false);

    const gzip = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(gzip.headers.get('Content-Encoding')).toBe('gzip');
    expect(existsSync(gzPath)).toBe(true);
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(HASHED_JS_BODY);

    const br = await serveFrontend(req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'br' }), root);
    expect(br.headers.get('Content-Encoding')).toBe('br');
    expect(existsSync(brPath)).toBe(true);
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(
      HASHED_JS_BODY
    );
  });

  test('只读 dist 写不出 sidecar 时回落到内存缓存，响应仍压缩', async () => {
    const root = await makeStaticRoot();
    await chmod(join(root, 'assets'), 0o555);
    const gzPath = join(root, 'assets', `${HASHED_JS}.gz`);

    const first = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(first.headers.get('Content-Encoding')).toBe('gzip');
    expect(existsSync(gzPath)).toBe(false);
    expect(gunzipSync(Buffer.from(await first.arrayBuffer())).toString()).toBe(HASHED_JS_BODY);

    const second = await serveFrontend(
      req(`/assets/${HASHED_JS}`, { 'Accept-Encoding': 'gzip' }),
      root
    );
    expect(second.headers.get('Content-Encoding')).toBe('gzip');
    expect(existsSync(gzPath)).toBe(false);
    expect(gunzipSync(Buffer.from(await second.arrayBuffer())).toString()).toBe(HASHED_JS_BODY);
  });
});
