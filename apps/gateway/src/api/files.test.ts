import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as deviceStorage from '../files/device-storage';
import { fail, ok } from '../files/rsync-operation';
import {
  createUploadSession,
  getDownloadSession,
  getUploadSession,
  removeDownloadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';
import { filesRoutes } from './files';
import { dispatchRoutes } from './route';

function dispatch(method: string, path: string, body?: unknown, init?: RequestInit) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : init?.headers,
    body: body !== undefined ? JSON.stringify(body) : init?.body,
  });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { server: {} as never, path: pathname });
}

async function readNdjson(response: Response): Promise<unknown[]> {
  const text = await response.text();
  if (!text) return [];
  return text
    .replace(/\n$/, '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

const spies: Array<{ mockRestore: () => void }> = [];
const uploadIds: string[] = [];
const downloadIds: string[] = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

afterEach(() => {
  while (spies.length > 0) {
    spies.pop()?.mockRestore();
  }
  while (uploadIds.length > 0) {
    const id = uploadIds.pop();
    if (id) removeUploadSession(id);
  }
  while (downloadIds.length > 0) {
    const id = downloadIds.pop();
    if (id) removeDownloadSession(id);
  }
});

describe('POST /api/files/upload/init size validation', () => {
  test('rejects fractional size so received (integer) can ever equal size', async () => {
    const response = await dispatch('POST', '/api/files/upload/init', {
      rootId: 'any-root',
      path: '/tmp',
      name: 'a.bin',
      size: 1.5,
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(await (response as Response).json()).toEqual({ error: t('apiError.invalidRequest') });
  });
});

describe('POST /api/files/upload/:id/commit NDJSON', () => {
  test('returns not_found when the upload session is missing', async () => {
    const response = await dispatch('POST', '/api/files/upload/missing/commit');
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(404);
    expect(await (response as Response).json()).toEqual({ error: 'not_found', code: 'not_found' });
  });

  test('returns invalid when the upload is incomplete', async () => {
    const session = createUploadSession({
      rootId: 'root',
      destDir: '/tmp',
      name: 'a.bin',
      size: 8,
    });
    uploadIds.push(session.id);

    const response = await dispatch('POST', `/api/files/upload/${session.id}/commit`);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(await (response as Response).json()).toEqual({
      error: 'invalid',
      code: 'invalid',
      detail: 'incomplete upload',
    });
  });

  test('streams progress and done then removes the session', async () => {
    const session = createUploadSession({
      rootId: 'root',
      destDir: '/tmp',
      name: 'a.bin',
      size: 0,
    });
    uploadIds.push(session.id);
    track(
      spyOn(deviceStorage, 'pushFileToDevice').mockImplementation(async (_a, _b, _c, _d, opts) => {
        opts?.onProgress?.({ transferred: 4, pct: 50, rate: '1.00MB/s' });
        opts?.onProgress?.({ transferred: 8, pct: 100, rate: '1.00MB/s' });
        return ok({ uploaded: 'a.bin' });
      })
    );

    const response = await dispatch('POST', `/api/files/upload/${session.id}/commit`);
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await readNdjson(res)).toEqual([
      { type: 'progress', transferred: 4, pct: 50, rate: '1.00MB/s' },
      { type: 'progress', transferred: 8, pct: 100, rate: '1.00MB/s' },
      { type: 'done', uploaded: 'a.bin' },
    ]);
    expect(getUploadSession(session.id)).toBeUndefined();
  });

  test('streams an error event when push fails', async () => {
    const session = createUploadSession({
      rootId: 'root',
      destDir: '/tmp',
      name: 'a.bin',
      size: 0,
    });
    uploadIds.push(session.id);
    track(
      spyOn(deviceStorage, 'pushFileToDevice').mockResolvedValue(fail('timeout', 'rsync hung'))
    );

    const response = await dispatch('POST', `/api/files/upload/${session.id}/commit`);
    expect(await readNdjson(response as Response)).toEqual([
      { type: 'error', code: 'timeout', detail: 'rsync hung' },
    ]);
    expect(getUploadSession(session.id)).toBeUndefined();
  });

  test('streams unknown error when push throws', async () => {
    const session = createUploadSession({
      rootId: 'root',
      destDir: '/tmp',
      name: 'a.bin',
      size: 0,
    });
    uploadIds.push(session.id);
    track(spyOn(deviceStorage, 'pushFileToDevice').mockRejectedValue(new Error('disk full')));

    const response = await dispatch('POST', `/api/files/upload/${session.id}/commit`);
    expect(await readNdjson(response as Response)).toEqual([
      { type: 'error', code: 'unknown', detail: 'Error: disk full' },
    ]);
    expect(getUploadSession(session.id)).toBeUndefined();
  });

  test('cancel removes the upload session', async () => {
    const session = createUploadSession({
      rootId: 'root',
      destDir: '/tmp',
      name: 'a.bin',
      size: 0,
    });
    uploadIds.push(session.id);
    const started = Promise.withResolvers<AbortSignal>();
    track(
      spyOn(deviceStorage, 'pushFileToDevice').mockImplementation((_a, _b, _c, _d, opts) => {
        if (!opts?.signal) throw new Error('missing signal');
        started.resolve(opts.signal);
        return new Promise(() => {});
      })
    );

    const response = await dispatch('POST', `/api/files/upload/${session.id}/commit`);
    expect(response).toBeInstanceOf(Response);
    await started.promise;
    await (response as Response).body?.cancel();
    expect(getUploadSession(session.id)).toBeUndefined();
  });
});

describe('POST /api/files/download/prepare NDJSON', () => {
  test('emits invalid when the body is not JSON', async () => {
    const response = await dispatch('POST', '/api/files/download/prepare', undefined, {
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(await readNdjson(res)).toEqual([{ type: 'error', code: 'invalid' }]);
  });

  test('emits invalid when rootId or path is missing', async () => {
    const response = await dispatch('POST', '/api/files/download/prepare', { rootId: 'root' });
    expect(await readNdjson(response as Response)).toEqual([{ type: 'error', code: 'invalid' }]);
  });

  test('streams progress and done then registers a download session', async () => {
    track(
      spyOn(deviceStorage, 'pullFileFromDevice').mockImplementation(async (_root, _path, opts) => {
        opts?.onProgress?.({ transferred: 2, pct: 25, rate: '512KB/s' });
        return ok({
          tmpPath: '/tmp/tmex-dl-fake/f',
          size: 10,
          name: 'note.txt',
          mime: 'text/plain',
          cleanup: () => {},
        });
      })
    );

    const response = await dispatch('POST', '/api/files/download/prepare', {
      rootId: 'root',
      path: '/notes/note.txt',
    });
    const events = await readNdjson(response as Response);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'progress', transferred: 2, pct: 25, rate: '512KB/s' });
    expect(events[1]).toMatchObject({ type: 'done', size: 10, name: 'note.txt' });
    const done = events[1] as { downloadId: string };
    downloadIds.push(done.downloadId);
    expect(getDownloadSession(done.downloadId)?.name).toBe('note.txt');
  });

  test('streams an error event when pull fails', async () => {
    track(spyOn(deviceStorage, 'pullFileFromDevice').mockResolvedValue(fail('not_found', 'gone')));

    const response = await dispatch('POST', '/api/files/download/prepare', {
      rootId: 'root',
      path: '/missing.txt',
    });
    expect(await readNdjson(response as Response)).toEqual([
      { type: 'error', code: 'not_found', detail: 'gone' },
    ]);
  });

  test('cancel aborts the in-flight pull', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    track(
      spyOn(deviceStorage, 'pullFileFromDevice').mockImplementation((_root, _path, opts) => {
        if (!opts?.signal) throw new Error('missing signal');
        started.resolve(opts.signal);
        return new Promise(() => {});
      })
    );

    const response = await dispatch('POST', '/api/files/download/prepare', {
      rootId: 'root',
      path: '/slow.bin',
    });
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    await (response as Response).body?.cancel();
    expect(signal.aborted).toBe(true);
  });
});
