import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowseDirectoryResponse, Device } from '@tmex/shared';
import * as devicesDb from '../db';
import * as deviceStorage from '../files/device-storage';
import { directoryBrowseIo } from '../files/directory-browse';
import * as sshCommand from '../files/ssh-command';
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

describe('transfer uid cleanup', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  const transferIds: string[] = [];

  afterEach(() => {
    for (const id of transferIds) abortTransfer(id);
    transferIds.length = 0;
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  function pinTransferId(): string {
    const id = crypto.randomUUID();
    spies.push(spyOn(crypto, 'randomUUID').mockImplementation(() => id));
    return id;
  }

  function mockStatDir() {
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
  }

  async function initOwnedUpload(uid: string, size: number): Promise<string> {
    mockStatDir();
    const response = await dispatchWithUid('POST', '/api/files/upload/init', uid, {
      rootId: 'root-1',
      path: '/tmp',
      name: 'a.bin',
      size,
    });
    const res = response as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadId: string };
    transferIds.push(body.uploadId);
    return body.uploadId;
  }

  async function prepareOwnedDownload(uid: string, payload: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from(payload));
    spies.push(
      spyOn(deviceStorage, 'pullFileFromDevice').mockResolvedValue({
        ok: true,
        data: {
          tmpPath,
          size: payload.length,
          name: 'a.bin',
          mime: 'application/octet-stream',
          cleanup: () => rmSync(dir, { recursive: true, force: true }),
        },
      })
    );
    const response = await dispatchWithUid('POST', '/api/files/download/prepare', uid, {
      rootId: 'root-1',
      path: '/tmp/a.bin',
    });
    const res = response as Response;
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; downloadId?: string });
    const done = lines.find((line) => line.type === 'done');
    expect(done?.downloadId).toBeString();
    transferIds.push(done?.downloadId ?? '');
    return done?.downloadId ?? '';
  }

  function expectReusedUploadHasNoUid(transferId: string) {
    const naked = createUploadSession({ rootId: 'r', destDir: '/d', name: 'b.bin', size: 1 });
    transferIds.push(naked.id);
    expect(naked.id).toBe(transferId);
    expect(getTransferOwner(transferId)?.uid).toBe('');
  }

  function expectReusedDownloadHasNoUid(transferId: string) {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const tmpPath = join(dir, 'f');
    writeFileSync(tmpPath, Buffer.from('x'));
    const naked = createDownloadSession({
      tmpPath,
      size: 1,
      name: 'b.bin',
      mime: 'application/octet-stream',
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    });
    transferIds.push(naked.id);
    expect(naked.id).toBe(transferId);
    expect(getTransferOwner(transferId)?.uid).toBe('');
  }

  test('upload commit forgets uid so a reused transfer id has empty owner', async () => {
    const transferId = pinTransferId();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await initOwnedUpload('user-commit-1', bytes.byteLength)).toBe(transferId);
    expect(getTransferOwner(transferId)?.uid).toBe('user-commit-1');

    const put = await dispatchRaw('PUT', `/api/files/upload/${transferId}?offset=0`, bytes);
    expect((put as Response).status).toBe(200);

    spies.push(
      spyOn(deviceStorage, 'pushFileToDevice').mockResolvedValue({
        ok: true,
        data: { uploaded: 'a.bin' },
      })
    );
    const commit = await dispatch('POST', `/api/files/upload/${transferId}/commit`);
    const commitRes = commit as Response;
    expect(commitRes.status).toBe(200);
    const lines = (await commitRes.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.some((line) => line.type === 'done')).toBe(true);

    expect(getUploadSession(transferId)).toBeUndefined();
    expect(getTransferOwner(transferId)).toBeNull();
    expectReusedUploadHasNoUid(transferId);
  });

  test('download content stream end forgets uid so a reused transfer id has empty owner', async () => {
    const transferId = pinTransferId();
    expect(await prepareOwnedDownload('user-dl-content-1', 'hello')).toBe(transferId);
    expect(getTransferOwner(transferId)?.uid).toBe('user-dl-content-1');

    const response = await dispatch('GET', `/api/files/download/${transferId}/content`);
    const res = response as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');

    expect(getDownloadSession(transferId)).toBeUndefined();
    expect(getTransferOwner(transferId)).toBeNull();
    expectReusedDownloadHasNoUid(transferId);
  });

  test('abort via DELETE forgets uid so a reused transfer id has empty owner', async () => {
    const uploadId = pinTransferId();
    expect(await initOwnedUpload('user-abort-up-1', 4)).toBe(uploadId);
    expect(getTransferOwner(uploadId)?.uid).toBe('user-abort-up-1');

    const cancelUp = await dispatch('DELETE', `/api/files/upload/${uploadId}`);
    expect((cancelUp as Response).status).toBe(200);
    expect(await (cancelUp as Response).json()).toEqual({ success: true });
    expect(getUploadSession(uploadId)).toBeUndefined();
    expect(getTransferOwner(uploadId)).toBeNull();
    expectReusedUploadHasNoUid(uploadId);

    for (const spy of spies) spy.mockRestore();
    spies.length = 0;

    const downloadId = pinTransferId();
    expect(await prepareOwnedDownload('user-abort-dl-1', 'bye')).toBe(downloadId);
    expect(getTransferOwner(downloadId)?.uid).toBe('user-abort-dl-1');

    const cancelDl = await dispatch('DELETE', `/api/files/download/${downloadId}`);
    expect((cancelDl as Response).status).toBe(200);
    expect(await (cancelDl as Response).json()).toEqual({ success: true });
    expect(getDownloadSession(downloadId)).toBeUndefined();
    expect(getTransferOwner(downloadId)).toBeNull();
    expectReusedDownloadHasNoUid(downloadId);
  });

  test('abortTransfer forgets uid so a reused transfer id has empty owner', async () => {
    const transferId = pinTransferId();
    expect(await initOwnedUpload('user-abort-hook-1', 2)).toBe(transferId);
    expect(getTransferOwner(transferId)?.uid).toBe('user-abort-hook-1');

    abortTransfer(transferId);
    expect(getUploadSession(transferId)).toBeUndefined();
    expect(getTransferOwner(transferId)).toBeNull();
    expectReusedUploadHasNoUid(transferId);
  });
});

describe('GET /api/files/browse', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  const sandboxDirs: string[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    for (const dir of sandboxDirs) rmSync(dir, { recursive: true, force: true });
    sandboxDirs.length = 0;
  });

  function localDevice(id = 'browse-http-local'): Device {
    return {
      id,
      name: 'local',
      type: 'local',
      authMode: 'auto',
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    };
  }

  test('400 when deviceId is missing', async () => {
    const response = await dispatch('GET', '/api/files/browse?path=/tmp');
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid', code: 'invalid' });
  });

  test('400 on a relative path', async () => {
    spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(localDevice()));
    const response = await dispatch(
      'GET',
      `/api/files/browse?deviceId=${localDevice().id}&path=relative/path`
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid', code: 'invalid' });
  });

  test('404 for an unknown device', async () => {
    spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(null));
    const response = await dispatch('GET', '/api/files/browse?deviceId=no-such-device&path=/tmp');
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'device_not_found', code: 'device_not_found' });
  });

  test('lists local subdirectories of a temp dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmex-browse-http-'));
    sandboxDirs.push(root);
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'file.txt'), 'x');
    spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(localDevice()));

    const response = await dispatch(
      'GET',
      `/api/files/browse?deviceId=${localDevice().id}&path=${encodeURIComponent(root)}`
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseDirectoryResponse;
    expect(body.entries.map((e) => e.name)).toEqual(['sub']);
    expect(body.truncated).toBe(false);
  });

  test('SSH browse uses a mocked remote exec', async () => {
    const sshDevice: Device = {
      id: 'browse-http-ssh',
      name: 'ssh',
      type: 'ssh',
      host: 'h',
      port: 22,
      username: 'u',
      authMode: 'key',
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    };
    spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(sshDevice));
    spies.push(
      spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
        targetPrefix: 'u@h:',
        rsh: 'ssh -p 22',
        env: {},
        cleanup: () => {},
      })
    );
    const stdout = new TextEncoder().encode('P/home/u\0d\0proj\0l\0link-dir\0');
    spies.push(
      spyOn(directoryBrowseIo, 'execSsh').mockResolvedValue({
        stdout,
        stderr: '',
        exitCode: 0,
      })
    );

    const response = await dispatch(
      'GET',
      `/api/files/browse?deviceId=${sshDevice.id}&path=${encodeURIComponent('/home/u')}`
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrowseDirectoryResponse;
    expect(body.path).toBe('/home/u');
    expect(body.parent).toBe('/home');
    expect(body.entries).toEqual([
      { name: 'link-dir', path: '/home/u/link-dir', hidden: false, symlink: true },
      { name: 'proj', path: '/home/u/proj', hidden: false, symlink: false },
    ]);
  });
});
