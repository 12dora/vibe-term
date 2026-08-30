import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as deviceStorage from '../files/device-storage';
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
    const dir = mkdtempSync(join(tmpdir(), 'tmex-rfile-test-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, bytes);
    return {
      tmpPath,
      size: Buffer.byteLength(bytes),
      name,
      mime: 'image/png',
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
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
    expect(await res.text()).toBe('PNGDATA');
    expect(existsSync(raw.tmpPath)).toBe(false);
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
