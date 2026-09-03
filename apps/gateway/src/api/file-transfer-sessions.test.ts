import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  abortTransfer,
  cleanupDownload,
  cleanupUpload,
  filesBulkHooks,
  getTransferOwner,
  rememberTransferUid,
} from './file-transfer-sessions';

describe('file-transfer-sessions', () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids) {
      removeUploadSession(id);
      removeDownloadSession(id);
    }
    ids.length = 0;
  });

  test('rememberTransferUid binds uid until cleanupUpload', () => {
    const session = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 4 });
    ids.push(session.id);
    expect(getTransferOwner(session.id)?.uid).toBe('');
    rememberTransferUid(session.id, 'user-1');
    expect(getTransferOwner(session.id)).toEqual({
      uid: 'user-1',
      tempPath: session.tmpPath,
      expectedSize: 4,
      kind: 'upload',
    });
    cleanupUpload(session.id);
    expect(getUploadSession(session.id)).toBeUndefined();
    expect(getTransferOwner(session.id)).toBeNull();
  });

  test('cleanupDownload forgets uid and removes the session', () => {
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
    ids.push(session.id);
    rememberTransferUid(session.id, 'user-dl');
    expect(getTransferOwner(session.id)?.uid).toBe('user-dl');
    cleanupDownload(session.id);
    expect(getDownloadSession(session.id)).toBeUndefined();
    expect(getTransferOwner(session.id)).toBeNull();
  });

  test('abortTransfer cleans upload and download sessions', () => {
    const upload = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 2 });
    ids.push(upload.id);
    rememberTransferUid(upload.id, 'u');
    abortTransfer(upload.id);
    expect(getUploadSession(upload.id)).toBeUndefined();
    expect(getTransferOwner(upload.id)).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from('x'));
    const download = createDownloadSession({
      tmpPath,
      size: 1,
      name: 'a.bin',
      mime: 'application/octet-stream',
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    });
    ids.push(download.id);
    rememberTransferUid(download.id, 'd');
    abortTransfer(download.id);
    expect(getDownloadSession(download.id)).toBeUndefined();
    expect(getTransferOwner(download.id)).toBeNull();
  });

  test('filesBulkHooks identity matches the session exports', () => {
    expect(filesBulkHooks.getTransferOwner).toBe(getTransferOwner);
    expect(filesBulkHooks.abortTransfer).toBe(abortTransfer);
  });

  test('appendUpload writes the same temp file HTTP PUT uses', async () => {
    const session = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.bin', size: 3 });
    ids.push(session.id);
    expect(await filesBulkHooks.appendUpload(session.id, new Uint8Array([1, 2, 3]))).toEqual({
      ok: true,
      received: 3,
    });
    expect(readFileSync(session.tmpPath)).toEqual(Buffer.from([1, 2, 3]));
  });
});
