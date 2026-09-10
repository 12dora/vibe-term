import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRequestedFile, serveFrontend } from './serve-frontend';

const tempDirs: string[] = [];
const HASHED_JS = 'index-a1b2c3d4.js';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibeterm-fe-'));
  tempDirs.push(root);
  await writeFile(join(root, 'index.html'), '<html>ok</html>');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', HASHED_JS), 'console.log(1)');
  await writeFile(join(root, 'assets', 'vendor.min-a_b2-3d4E.js'), 'console.log(2)');
  await writeFile(join(root, 'assets', 'ghostty-vt-a1b2c3d4.wasm'), 'wasm');
  await mkdir(join(root, 'fonts'), { recursive: true });
  await writeFile(join(root, 'fonts', 'GeistMonoNerdFontMono-Regular.woff2'), 'woff2');
  await writeFile(join(root, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  return root;
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
    const response = await serveFrontend(new Request('http://127.0.0.1/%ZZ'), root);
    expect(response.status).toBe(400);
  });

  test('sends immutable Cache-Control for hashed Vite assets', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(new Request(`http://127.0.0.1/assets/${HASHED_JS}`), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('console.log(1)');
  });

  test('treats base64url hashes with _ and - as immutable assets', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      new Request('http://127.0.0.1/assets/vendor.min-a_b2-3d4E.js'),
      root
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('sends no-cache plus ETag and Last-Modified for index.html', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(new Request('http://127.0.0.1/index.html'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('ETag')).toMatch(/^W\/"\d+-\d+"$/);
    expect(response.headers.get('Last-Modified')).toBeTruthy();
    expect(response.headers.get('Vary')).toBeNull();
    expect(await response.text()).toBe('<html>ok</html>');
  });

  test('returns 304 when If-None-Match matches the ETag', async () => {
    const root = await makeStaticRoot();
    const first = await serveFrontend(new Request('http://127.0.0.1/index.html'), root);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    await first.arrayBuffer();

    const again = await serveFrontend(
      new Request('http://127.0.0.1/index.html', { headers: { 'If-None-Match': etag! } }),
      root
    );
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(etag);
    expect(again.headers.get('Cache-Control')).toBe('no-cache');
    expect(await again.text()).toBe('');
  });

  test('returns 304 when If-Modified-Since matches Last-Modified', async () => {
    const root = await makeStaticRoot();
    const first = await serveFrontend(
      new Request('http://127.0.0.1/fonts/GeistMonoNerdFontMono-Regular.woff2'),
      root
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-cache');
    const lastModified = first.headers.get('Last-Modified');
    expect(lastModified).toBeTruthy();
    await first.arrayBuffer();

    const again = await serveFrontend(
      new Request('http://127.0.0.1/fonts/GeistMonoNerdFontMono-Regular.woff2', {
        headers: { 'If-Modified-Since': lastModified! },
      }),
      root
    );
    expect(again.status).toBe(304);
  });
});

describe('service worker 与 wasm 的下发口径', () => {
  test('/sw.js 走根作用域、no-cache、JS MIME（作用域外或缓存住都会让更新卡死）', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(new Request('http://127.0.0.1/sw.js'), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toContain('text/javascript');
    expect(response.headers.get('ETag')).toMatch(/^W\/"\d+-\d+"$/);
    expect(await response.text()).toContain('addEventListener');
  });

  test('缺 sw.js 时 404 而不是 SPA fallback 成 index.html', async () => {
    const root = await makeStaticRoot();
    await rm(join(root, 'sw.js'));
    const response = await serveFrontend(new Request('http://127.0.0.1/sw.js'), root);
    expect(response.status).toBe(404);
  });

  test('.wasm 下发 application/wasm，instantiateStreaming 才认', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      new Request('http://127.0.0.1/assets/ghostty-vt-a1b2c3d4.wasm'),
      root
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/wasm');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('woff2 下发 font/woff2', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(
      new Request('http://127.0.0.1/fonts/GeistMonoNerdFontMono-Regular.woff2'),
      root
    );
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
      const res = await serveFrontend(new Request(`http://127.0.0.1${path}`), root);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(await res.text()).toBe('<html>ok</html>');
    }
  });
});
