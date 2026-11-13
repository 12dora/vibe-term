import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as deviceStorage from '../files/device-storage';
import { requestDispatchContext } from '../mesh/types';
import { fileBrowserRoutes } from './file-browser-routes';
import { dispatchRoutes } from './route';

function dispatch(req: Request) {
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, fileBrowserRoutes, { path: pathname });
}

describe('GET /api/files/raw streams the temp file', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempRaw(bytes: string, name = 'pic.png') {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rfile-test-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, bytes);
    const size = Buffer.byteLength(bytes);
    return {
      tmpPath,
      size,
      name,
      mime: 'image/png',
      temporary: true,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
      source: { size, mtimeMs: 1_700_000_000_000, path: `/${name}` },
    };
  }

  test('streams bytes, sets content headers, cleans up after EOF', async () => {
    const raw = tempRaw('PNGDATA', 'a.png');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({ ok: true, data: { ...raw } })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png&download=1')
    )) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe(String(raw.size));
    expect(res.headers.get('Content-Disposition')).toContain('filename="a.png"');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    expect(res.headers.get('X-VibeTerm-Entity-Length')).toBe(String(raw.size));
    expect(await res.text()).toBe('PNGDATA');
    expect(existsSync(raw.tmpPath)).toBe(false);
  });

  test('Range 闭区间返回 206，entity-length 仍是全文件', async () => {
    const raw = tempRaw('PNGDATA', 'a.png');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({ ok: true, data: { ...raw } })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png', {
        headers: { Range: 'bytes=1-3' },
      })
    )) as Response;
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('NGD');
    expect(res.headers.get('Content-Range')).toBe('bytes 1-3/7');
    expect(res.headers.get('X-VibeTerm-Entity-Length')).toBe('7');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(existsSync(raw.tmpPath)).toBe(false);
  });

  test('合法单段起点越界返回 416', async () => {
    const raw = tempRaw('PNGDATA', 'a.png');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({ ok: true, data: { ...raw } })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png', {
        headers: { Range: 'bytes=7-' },
      })
    )) as Response;
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */7');
  });

  test('畸形或多段 Range 忽略，回 200 全文', async () => {
    const raw = tempRaw('PNGDATA', 'a.png');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({ ok: true, data: { ...raw } })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png', {
        headers: { Range: 'bytes=0-1,2-3' },
      })
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
  });

  test('本机直读 temporary=false 不删除源文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rfile-local-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'a.png');
    writeFileSync(tmpPath, 'PNGDATA');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({
        ok: true,
        data: {
          tmpPath,
          size: 7,
          name: 'a.png',
          mime: 'image/png',
          temporary: false,
          cleanup: () => rmSync(tmpPath, { force: true }),
          source: { size: 7, mtimeMs: 9, ino: 1 },
        },
      })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png')
    )) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('7');
    expect(await res.text()).toBe('PNGDATA');
    expect(existsSync(tmpPath)).toBe(true);
  });

  test('cancel cleans up the temp file', async () => {
    const raw = tempRaw('ABCDEF');
    spies.push(
      spyOn(deviceStorage, 'readRawFile').mockResolvedValue({ ok: true, data: { ...raw } })
    );
    const res = (await dispatch(
      new Request('http://localhost/api/files/raw?rootId=r1&path=%2Fa.png')
    )) as Response;
    expect(res.status).toBe(200);
    expect(existsSync(raw.tmpPath)).toBe(true);
    await res.body?.cancel();
    expect(existsSync(raw.tmpPath)).toBe(false);
  });
});

describe('GET /api/files/browse token principal', () => {
  test('token principal is 403 TOKEN_SCOPE; session is not', async () => {
    const tokenReq = new Request('http://localhost/api/files/browse?deviceId=d1&path=%2Ftmp');
    requestDispatchContext.set(tokenReq, { uid: 'tok-user', viaNodeId: 'self', tokenId: 'tok-1' });
    const denied = (await dispatch(tokenReq)) as Response;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'TOKEN_SCOPE' });

    const sessionReq = new Request('http://localhost/api/files/browse?path=%2Ftmp');
    requestDispatchContext.set(sessionReq, { uid: 'user-1', viaNodeId: 'self', sid: 'sid-1' });
    const session = (await dispatch(sessionReq)) as Response;
    expect(session.status).toBe(400);
    expect(await session.json()).toMatchObject({ code: 'invalid' });
  });
});
