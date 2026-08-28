import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as deviceStorage from '../files/device-storage';
import {
  createDownloadSession,
  createUploadSession,
  getDownloadSession,
  getUploadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import {
  abortTransfer,
  appendUpload,
  filesBulkHooks,
  filesRoutes,
  getTransferOwner,
  openDownload,
} from './files';
import { dispatchRoutes } from './route';

function dispatch(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { path: pathname });
}

function dispatchRaw(method: string, path: string, body?: BodyInit) {
  const req = new Request(`http://localhost${path}`, { method, body });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { path: pathname });
}

function dispatchWithUid(method: string, path: string, uid: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  requestDispatchContext.set(req, { uid, viaNodeId: 'self' });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, filesRoutes, { path: pathname });
}

async function expectInvalidRequest(response: Response | Promise<Response> | undefined) {
  expect(response).toBeInstanceOf(Response);
  const res = response as Response;
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: t('apiError.invalidRequest') });
}

describe('POST /api/files/upload/init size validation', () => {
  test('rejects fractional size so received (integer) can ever equal size', async () => {
    await expectInvalidRequest(
      await dispatch('POST', '/api/files/upload/init', {
        rootId: 'any-root',
        path: '/tmp',
        name: 'a.bin',
        size: 1.5,
      })
    );
  });
});

describe('PUT /api/files/upload/:id offset validation', () => {
  test('rejects trailing-garbage offset that parseInt would coerce (12garbage → 12)', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id?offset=12garbage', new Uint8Array([1]))
    );
  });

  test('rejects fractional offset that parseInt would truncate (12.5 → 12)', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id?offset=12.5', new Uint8Array([1]))
    );
  });

  test('rejects missing offset instead of treating empty string as 0', async () => {
    await expectInvalidRequest(
      await dispatchRaw('PUT', '/api/files/upload/any-id', new Uint8Array([1]))
    );
  });

  test('accepts an exact non-negative integer offset and then reports missing session', async () => {
    const response = await dispatchRaw(
      'PUT',
      '/api/files/upload/missing?offset=0',
      new Uint8Array([1])
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
  });

  test('accepts decimal offset 12 and then reports missing session', async () => {
    const response = await dispatchRaw(
      'PUT',
      '/api/files/upload/missing?offset=12',
      new Uint8Array([1])
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
  });

  for (const offset of [' ', '0x10', '1e2']) {
    test(`rejects offset ${JSON.stringify(offset)} that Number() would coerce`, async () => {
      await expectInvalidRequest(
        await dispatchRaw(
          'PUT',
          `/api/files/upload/any-id?offset=${encodeURIComponent(offset)}`,
          new Uint8Array([1])
        )
      );
    });
  }
});

describe('JSON object body validation', () => {
  test('POST /api/files/roots rejects JSON null instead of throwing on property access', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/roots', null));
  });

  test('POST /api/files/roots rejects a JSON array body', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/roots', []));
  });

  test('POST /api/files/upload/init rejects JSON null instead of throwing on property access', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/upload/init', null));
  });

  test('POST /api/files/upload/init rejects a JSON array body', async () => {
    await expectInvalidRequest(await dispatch('POST', '/api/files/upload/init', []));
  });

  test('POST /api/files/download/prepare emits NDJSON invalid on JSON null instead of throwing', async () => {
    const response = await dispatch('POST', '/api/files/download/prepare', null);
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.text()).trim())).toEqual({ type: 'error', code: 'invalid' });
  });
});

describe('files bulk hooks', () => {
  test('getTransferOwner returns upload temp path and empty uid without mesh context', () => {
    const session = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 4 });
    try {
      expect(getTransferOwner(session.id)).toEqual({
        uid: '',
        tempPath: session.tmpPath,
        expectedSize: 4,
        kind: 'upload',
      });
      expect(getTransferOwner('missing')).toBeNull();
    } finally {
      removeUploadSession(session.id);
    }
  });

  test('appendUpload writes the same temp file HTTP PUT uses so commit can succeed', () => {
    const session = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 5 });
    try {
      expect(appendUpload(session.id, new Uint8Array([1, 2, 3]))).toEqual({
        ok: true,
        received: 3,
      });
      expect(appendUpload(session.id, new Uint8Array([4, 5]))).toEqual({
        ok: true,
        received: 5,
      });
      expect(getUploadSession(session.id)?.received).toBe(5);
      expect(readFileSync(session.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(appendUpload(session.id, new Uint8Array([6]))).toEqual({
        ok: false,
        code: 'too_large',
      });
    } finally {
      removeUploadSession(session.id);
    }
  });

  test('abortTransfer removes the upload session and temp dir', () => {
    const session = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 2 });
    const tmpDir = session.tmpDir;
    abortTransfer(session.id);
    expect(getUploadSession(session.id)).toBeUndefined();
    expect(getTransferOwner(session.id)).toBeNull();
    expect(() => readFileSync(join(tmpDir, 'f'))).toThrow();
  });

  test('openDownload streams the prepared temp file and cleans up on end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from('hello'));
    const session = createDownloadSession({
      tmpPath,
      size: 5,
      name: 'a.bin',
      mime: 'application/octet-stream',
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    });
    const stream = openDownload(session.id);
    expect(stream).not.toBeNull();
    const reader = stream?.getReader();
    const chunks: Uint8Array[] = [];
    if (!reader) throw new Error('missing reader');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(getDownloadSession(session.id)).toBeUndefined();
    expect(getTransferOwner(session.id)).toBeNull();
  });

  test('openDownload returns null for an unknown id', () => {
    expect(openDownload('missing')).toBeNull();
  });

  test('filesBulkHooks exposes the four operations', () => {
    expect(filesBulkHooks.getTransferOwner).toBe(getTransferOwner);
    expect(filesBulkHooks.openDownload).toBe(openDownload);
    expect(filesBulkHooks.appendUpload).toBe(appendUpload);
    expect(filesBulkHooks.abortTransfer).toBe(abortTransfer);
  });
});

describe('HTTP transfer uid binding', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  const transferIds: string[] = [];

  afterEach(() => {
    for (const id of transferIds) abortTransfer(id);
    transferIds.length = 0;
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  test('upload/init remembers the request uid on the transfer owner', async () => {
    spies.push(
      spyOn(deviceStorage, 'statFile').mockResolvedValue({
        ok: true,
        data: {
          path: '/tmp',
          name: 'tmp',
          type: 'dir',
          category: 'directory',
          size: 0,
          modifiedAt: null,
          mime: null,
          isSymlink: false,
        },
      })
    );

    const response = await dispatchWithUid('POST', '/api/files/upload/init', 'user-upload-1', {
      rootId: 'root-1',
      path: '/tmp',
      name: 'a.bin',
      size: 4,
    });
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadId: string };
    transferIds.push(body.uploadId);
    expect(getTransferOwner(body.uploadId)?.uid).toBe('user-upload-1');
  });

  test('download/prepare remembers the request uid on the transfer owner', async () => {
    spies.push(
      spyOn(deviceStorage, 'pullFileFromDevice').mockResolvedValue({
        ok: true,
        data: {
          tmpPath: '/tmp/tmex-dl-fake',
          size: 4,
          name: 'a.bin',
          mime: 'application/octet-stream',
          cleanup: () => {},
        },
      })
    );

    const response = await dispatchWithUid(
      'POST',
      '/api/files/download/prepare',
      'user-download-1',
      {
        rootId: 'root-1',
        path: '/tmp/a.bin',
      }
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; downloadId?: string });
    const done = lines.find((line) => line.type === 'done');
    expect(done?.downloadId).toBeString();
    transferIds.push(done?.downloadId ?? '');
    expect(getTransferOwner(done?.downloadId ?? '')?.uid).toBe('user-download-1');
  });
});
