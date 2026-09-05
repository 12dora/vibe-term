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
  const root = await mkdtemp(join(tmpdir(), 'tmex-fe-'));
  tempDirs.push(root);
  await writeFile(join(root, 'index.html'), '<html>ok</html>');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', HASHED_JS), 'console.log(1)');
  await writeFile(join(root, 'assets', 'vendor.min-a_b2-3d4E.js'), 'console.log(2)');
  await mkdir(join(root, 'fonts'), { recursive: true });
  await writeFile(join(root, 'fonts', 'GeistMonoNerdFontMono-Regular.woff2'), 'woff2');
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
