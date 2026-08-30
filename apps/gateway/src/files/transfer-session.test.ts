import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendUploadChunk,
  appendUploadChunkAsync,
  createUploadSession,
  getUploadSession,
  removeUploadSession,
  sweepOrphanTransferTemps,
} from './transfer-session';

describe('upload session chunking', () => {
  test('sequential append; rejects bad offset / overflow / missing session', () => {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 6 });
    expect(existsSync(s.tmpPath)).toBe(true);

    expect(appendUploadChunk(s.id, 0, new Uint8Array([1, 2, 3]))).toEqual({
      ok: true,
      received: 3,
    });
    // 非顺序 offset 被拒
    expect(appendUploadChunk(s.id, 0, new Uint8Array([9]))).toEqual({
      ok: false,
      reason: 'bad_offset',
    });
    // 超出声明 size 被拒
    expect(appendUploadChunk(s.id, 3, new Uint8Array([4, 5, 6, 7]))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    // 正确补齐
    expect(appendUploadChunk(s.id, 3, new Uint8Array([4, 5, 6]))).toEqual({
      ok: true,
      received: 6,
    });
    expect(getUploadSession(s.id)?.received).toBe(6);

    const tmpDir = s.tmpDir;
    removeUploadSession(s.id);
    expect(getUploadSession(s.id)).toBeUndefined();
    expect(existsSync(tmpDir)).toBe(false);
    expect(appendUploadChunk(s.id, 0, new Uint8Array([1]))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('appendUploadChunkAsync writes then advances received', async () => {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 4 });
    const pending = appendUploadChunkAsync(s.id, 0, new Uint8Array([9, 8]));
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ ok: true, received: 2 });
    expect(getUploadSession(s.id)?.received).toBe(2);
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([9, 8]));
    expect(await appendUploadChunkAsync(s.id, 2, new Uint8Array([7, 6]))).toEqual({
      ok: true,
      received: 4,
    });
    expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([9, 8, 7, 6]));
    removeUploadSession(s.id);
  });

  test('concurrent offset=0 appends: one succeeds, the other is bad_offset', async () => {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 6 });
    const a = new Uint8Array([1, 1, 1]);
    const b = new Uint8Array([2, 2, 2]);
    const [r1, r2] = await Promise.all([
      appendUploadChunkAsync(s.id, 0, a),
      appendUploadChunkAsync(s.id, 0, b),
    ]);
    const results = [r1, r2];
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    expect(ok).toEqual([{ ok: true, received: 3 }]);
    expect(bad).toEqual([{ ok: false, reason: 'bad_offset' }]);
    expect(getUploadSession(s.id)?.received).toBe(3);
    const onDisk = readFileSync(s.tmpPath);
    expect(onDisk.byteLength).toBe(3);
    const winner = r1.ok ? a : b;
    expect(onDisk).toEqual(Buffer.from(winner));
    removeUploadSession(s.id);
  });

  describe('async append fs edge cases', () => {
    const realOpen = fsPromises.open;
    const spies: Array<ReturnType<typeof spyOn>> = [];
    afterEach(() => {
      for (const spy of spies) spy.mockRestore();
      spies.length = 0;
    });

    function mockOpen(
      wrap: (fh: Awaited<ReturnType<typeof realOpen>>) => {
        write: (buf: Uint8Array) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
        truncate: (len?: number) => Promise<void>;
        close: () => Promise<void>;
      }
    ) {
      spies.push(
        spyOn(fsPromises, 'open').mockImplementation(async (path, flags) => {
          const fh = await realOpen(path, flags);
          return wrap(fh) as Awaited<ReturnType<typeof realOpen>>;
        })
      );
    }

    test('loops until the full buffer is persisted', async () => {
      const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 4 });
      mockOpen((fh) => ({
        write: async (buf) => {
          const n = Math.min(1, buf.byteLength);
          await fh.write(buf.subarray(0, n));
          return { bytesWritten: n, buffer: buf };
        },
        truncate: (len) => fh.truncate(len),
        close: () => fh.close(),
      }));
      expect(await appendUploadChunkAsync(s.id, 0, new Uint8Array([1, 2, 3, 4]))).toEqual({
        ok: true,
        received: 4,
      });
      expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3, 4]));
      removeUploadSession(s.id);
    });

    test('write half then throw truncates back to received', async () => {
      const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 8 });
      mockOpen((fh) => ({
        write: async (buf) => {
          const n = Math.max(1, Math.floor(buf.byteLength / 2));
          await fh.write(buf.subarray(0, n));
          throw new Error('ENOSPC');
        },
        truncate: (len) => fh.truncate(len),
        close: () => fh.close(),
      }));
      await expect(appendUploadChunkAsync(s.id, 0, new Uint8Array(8).fill(9))).rejects.toThrow(
        'ENOSPC'
      );
      expect(statSync(s.tmpPath).size).toBe(0);
      expect(getUploadSession(s.id)?.received).toBe(0);
      spies[0]?.mockRestore();
      spies.length = 0;
      expect(await appendUploadChunkAsync(s.id, 0, new Uint8Array([1, 2, 3]))).toEqual({
        ok: true,
        received: 3,
      });
      expect(readFileSync(s.tmpPath)).toEqual(Buffer.from([1, 2, 3]));
      removeUploadSession(s.id);
    });

    test('cancel while append is in flight does not report success', async () => {
      const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 8 });
      let releaseWrite!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let startedWrite!: () => void;
      const started = new Promise<void>((resolve) => {
        startedWrite = resolve;
      });
      mockOpen((fh) => ({
        write: async (buf) => {
          startedWrite();
          await held;
          return fh.write(buf);
        },
        truncate: (len) => fh.truncate(len),
        close: () => fh.close(),
      }));
      const pending = appendUploadChunkAsync(s.id, 0, new Uint8Array([1, 2, 3, 4]));
      await started;
      removeUploadSession(s.id);
      releaseWrite();
      expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
      expect(getUploadSession(s.id)).toBeUndefined();
    });
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
