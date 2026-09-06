import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDownloadSession,
  createUploadSession,
  getDownloadSession,
  getUploadSession,
  removeDownloadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { filesRoutes } from './files';
import { dispatchRoutes } from './route';

const CHUNK_SIZE = 8 * 1024 * 1024;

function dispatch(req: Request) {
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { path: pathname });
}

describe('PUT /api/files/upload/:id bounded body', () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids) removeUploadSession(id);
    ids.length = 0;
  });

  function session(size: number) {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size });
    ids.push(s.id);
    return s;
  }

  test('oversize Content-Length vs chunk size → 413 without reading the body', async () => {
    const s = session(CHUNK_SIZE * 2);
    let read = false;
    const req = new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
      method: 'PUT',
      headers: { 'Content-Length': String(CHUNK_SIZE + 1) },
    });
    req.arrayBuffer = async () => {
      read = true;
      return new ArrayBuffer(0);
    };
    req.bytes = async () => {
      read = true;
      return new Uint8Array();
    };
    req.text = async () => {
      read = true;
      return '';
    };
    const res = (await dispatch(req)) as Response;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', code: 'too_large' });
    expect(read).toBe(false);
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('oversize Content-Length vs remaining declared size → 413 without reading', async () => {
    const s = session(10);
    let read = false;
    const req = new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
      method: 'PUT',
      headers: { 'Content-Length': '11' },
    });
    req.arrayBuffer = async () => {
      read = true;
      return new ArrayBuffer(0);
    };
    const res = (await dispatch(req)) as Response;
    expect(res.status).toBe(413);
    expect(read).toBe(false);
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('body longer than Content-Length → 413 and session unchanged', async () => {
    const s = session(100);
    const body = new Uint8Array(20).fill(7);
    const req = new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
      method: 'PUT',
      headers: { 'Content-Length': '10' },
      body,
    });
    const res = (await dispatch(req)) as Response;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', code: 'too_large' });
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('body exactly at remaining size → 200 with received = size', async () => {
    const s = session(10);
    const body = new Uint8Array(10).fill(1);
    const res = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
        method: 'PUT',
        headers: { 'Content-Length': '10' },
        body,
      })
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 10, complete: true });
    expect(getUploadSession(s.id)?.received).toBe(10);
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from(body));
  });

  test('body one byte over remaining size without Content-Length → 413', async () => {
    const s = session(10);
    const res = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
        method: 'PUT',
        body: new Uint8Array(11).fill(1),
      })
    )) as Response;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', code: 'too_large' });
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('happy path: sequential chunks written asynchronously, received matches bytes', async () => {
    const s = session(6);
    const first = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      })
    )) as Response;
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: 3, complete: false });
    expect(getUploadSession(s.id)?.received).toBe(3);

    const second = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=3`, {
        method: 'PUT',
        body: new Uint8Array([4, 5, 6]),
      })
    )) as Response;
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: 6, complete: true });
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  test('乱序 / 并行区间：两段不相交的 PUT 都成功且字节一致', async () => {
    const s = session(6);
    const [a, b] = await Promise.all([
      dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}?offset=3&length=3`, {
          method: 'PUT',
          body: new Uint8Array([4, 5, 6]),
        })
      ) as Promise<Response>,
      dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}?offset=0&length=3`, {
          method: 'PUT',
          body: new Uint8Array([1, 2, 3]),
        })
      ) as Promise<Response>,
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(getUploadSession(s.id)?.received).toBe(6);
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  test('length 查询参数与 content-length 不符时以 length 为准判定截断', async () => {
    const s = session(10);
    const res = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=0&length=10`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      })
    )) as Response;
    expect(res.status).toBe(409);
    expect(getUploadSession(s.id)?.received).toBe(3);
  });

  test('DELETE while PUT append is in flight does not report success', async () => {
    const s = session(8);
    const realOpen = fsPromises.open;
    let releaseWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let startedWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      startedWrite = resolve;
    });
    const spy = spyOn(fsPromises, 'open').mockImplementation(async (path, flags) => {
      const fh = await realOpen(path, flags);
      return {
        write: async (buf: Uint8Array) => {
          startedWrite();
          await held;
          return fh.write(buf);
        },
        truncate: (len?: number) => fh.truncate(len),
        close: () => fh.close(),
      } as Awaited<ReturnType<typeof realOpen>>;
    });
    try {
      const put = dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
          method: 'PUT',
          body: new Uint8Array([1, 2, 3, 4]),
        })
      ) as Promise<Response>;
      await started;
      const del = (await dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}`, { method: 'DELETE' })
      )) as Response;
      expect(del.status).toBe(200);
      releaseWrite();
      const putRes = await put;
      expect(putRes.status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('分块 PUT 的硬上限与下载会话保留', () => {
  const ids: string[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const id of ids) {
      removeUploadSession(id);
      removeDownloadSession(id);
    }
    ids.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  test('不带 length / content-length 的分块请求仍受 8 MiB 上限约束', async () => {
    const s = createUploadSession({
      rootId: 'r',
      destDir: '/d',
      name: 'big.bin',
      size: CHUNK_SIZE * 2,
    });
    ids.push(s.id);
    const chunk = new Uint8Array(64 * 1024).fill(3);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > CHUNK_SIZE) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
        method: 'PUT',
        body,
        duplex: 'half',
      } as RequestInit)
    )) as Response;
    expect(res.status).toBe(413);
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('下载内容读完不回收会话：可以再用 Range 续传，DELETE 才清理', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from('hello'));
    const session = createDownloadSession({
      tmpPath,
      size: 5,
      name: 'a.bin',
      mime: 'application/octet-stream',
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    });
    ids.push(session.id);

    const full = (await dispatch(
      new Request(`http://localhost/api/files/download/${session.id}/content`)
    )) as Response;
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('hello');
    expect(getDownloadSession(session.id)).toBeDefined();

    const resumed = (await dispatch(
      new Request(`http://localhost/api/files/download/${session.id}/content`, {
        headers: { Range: 'bytes=2-' },
      })
    )) as Response;
    expect(resumed.status).toBe(206);
    expect(await resumed.text()).toBe('llo');
    expect(getDownloadSession(session.id)).toBeDefined();

    const del = (await dispatch(
      new Request(`http://localhost/api/files/download/${session.id}`, { method: 'DELETE' })
    )) as Response;
    expect(del.status).toBe(200);
    expect(getDownloadSession(session.id)).toBeUndefined();
  });

  test('源文件在续传途中被改写：干净失败并回收会话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    dirs.push(dir);
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from('hello'));
    const session = createDownloadSession({
      tmpPath,
      size: 5,
      name: 'a.bin',
      mime: null,
      cleanup: () => {},
    });
    ids.push(session.id);
    writeFileSync(tmpPath, Buffer.from('HELLO WORLD'));
    const res = (await dispatch(
      new Request(`http://localhost/api/files/download/${session.id}/content`, {
        headers: { Range: 'bytes=2-' },
      })
    )) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid' });
    expect(getDownloadSession(session.id)).toBeUndefined();
  });
});
