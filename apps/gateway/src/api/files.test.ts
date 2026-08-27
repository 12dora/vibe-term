import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDownloadSession,
  createUploadSession,
  getDownloadSession,
  getUploadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';
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
  return dispatchRoutes(req, pathname, filesRoutes, { server: {} as never, path: pathname });
}

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
