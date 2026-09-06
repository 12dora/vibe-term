import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUploadSession,
  getUploadSession,
  removeUploadSession,
  sweepOrphanTransferTemps,
  writeUploadBytes,
  writeUploadRange,
} from './transfer-session';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('upload session ranged writes', () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids) removeUploadSession(id);
    ids.length = 0;
  });

  function session(size: number) {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size });
    ids.push(s.id);
    return s;
  }

  test('sequential ranges fill the file and rename it into place on completion', async () => {
    const s = session(6);
    // 收满之前只有 `.part`，最终文件到位才代表可以 commit
    expect(existsSync(s.tmpPath)).toBe(false);
    expect(await writeUploadBytes(s.id, 0, new Uint8Array([1, 2, 3]))).toEqual({
      ok: true,
      received: 3,
      complete: false,
    });
    expect(getUploadSession(s.id)?.received).toBe(3);
    expect(await writeUploadBytes(s.id, 3, new Uint8Array([4, 5, 6]))).toEqual({
      ok: true,
      received: 6,
      complete: true,
    });
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  test('out-of-order ranges reassemble', async () => {
    const s = session(6);
    expect(await writeUploadBytes(s.id, 3, new Uint8Array([4, 5, 6]))).toMatchObject({
      ok: true,
      received: 3,
      complete: false,
    });
    expect(await writeUploadBytes(s.id, 0, new Uint8Array([1, 2, 3]))).toMatchObject({
      ok: true,
      complete: true,
    });
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  test('parallel disjoint ranges are byte identical to a sequential write', async () => {
    const s = session(4096);
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    await Promise.all(
      [0, 1024, 2048, 3072].map((offset) =>
        writeUploadRange(s.id, {
          offset,
          contentLength: 1024,
          body: streamOf(bytes.subarray(offset, offset + 1024)),
        })
      )
    );
    expect(getUploadSession(s.id)?.received).toBe(4096);
    expect(getUploadSession(s.id)?.complete).toBe(true);
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from(bytes));
  });

  test('a range past the declared size is rejected', async () => {
    const s = session(4);
    expect(await writeUploadBytes(s.id, 3, new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(getUploadSession(s.id)?.received).toBe(0);
  });

  test('a body shorter than the declared length reports incomplete and keeps what landed', async () => {
    const s = session(10);
    expect(
      await writeUploadRange(s.id, {
        offset: 0,
        contentLength: 10,
        body: streamOf(new Uint8Array([1, 2, 3])),
      })
    ).toEqual({ ok: false, reason: 'incomplete' });
    expect(getUploadSession(s.id)?.received).toBe(3);
  });

  test('a removed session rejects further writes', async () => {
    const s = session(4);
    const tmpDir = s.tmpDir;
    removeUploadSession(s.id);
    expect(getUploadSession(s.id)).toBeUndefined();
    expect(existsSync(tmpDir)).toBe(false);
    expect(await writeUploadBytes(s.id, 0, new Uint8Array([1]))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('a zero-byte upload is complete on creation', () => {
    const s = session(0);
    expect(s.complete).toBe(true);
    expect(readFileSync(s.tmpPath).byteLength).toBe(0);
  });

  test('sweepOrphanTransferTemps 仅清理超期的传输临时目录', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'tmex-up-'));
    const freshDir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const unrelated = mkdtempSync(join(tmpdir(), 'tmex-keep-'));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h 前
    utimesSync(oldDir, old, old);
    try {
      sweepOrphanTransferTemps();
      expect(existsSync(oldDir)).toBe(false); // 超期 → 清理
      expect(existsSync(freshDir)).toBe(true); // 新建 → 保留
      expect(existsSync(unrelated)).toBe(true); // 非传输前缀 → 不动
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(oldDir, { recursive: true, force: true });
    }
  });
});
