import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  createUploadSession,
  getUploadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';
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
    expect(readFileSync(s.tmpPath).byteLength).toBe(0);
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
    expect(await first.json()).toEqual({ received: 3 });
    expect(getUploadSession(s.id)?.received).toBe(3);
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3]));

    const second = (await dispatch(
      new Request(`http://localhost/api/files/upload/${s.id}?offset=3`, {
        method: 'PUT',
        body: new Uint8Array([4, 5, 6]),
      })
    )) as Response;
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: 6 });
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  test('concurrent offset=0 PUTs: one 200, the other 409', async () => {
    const s = session(6);
    const [a, b] = await Promise.all([
      dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
          method: 'PUT',
          body: new Uint8Array([1, 2, 3]),
        })
      ) as Promise<Response>,
      dispatch(
        new Request(`http://localhost/api/files/upload/${s.id}?offset=0`, {
          method: 'PUT',
          body: new Uint8Array([4, 5, 6]),
        })
      ) as Promise<Response>,
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(await winner.json()).toEqual({ received: 3 });
    expect(await loser.json()).toEqual({ error: t('apiError.invalidRequest') });
    expect(getUploadSession(s.id)?.received).toBe(3);
    expect(readFileSync(s.tmpPath).byteLength).toBe(3);
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
