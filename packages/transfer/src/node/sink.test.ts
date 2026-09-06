import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumableSink, type SinkDescriptor, deterministicPartPath, partPathOf } from './sink';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-sink-test-'));
  dirs.push(dir);
  return dir;
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function payload(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = i % 251;
  return out;
}

describe('ResumableSink append mode', () => {
  test('.part name is content addressed and stable', () => {
    const dest = '/tmp/pkg.tgz';
    const sha = 'a'.repeat(64);
    expect(deterministicPartPath(dest, sha)).toBe(`${dest}.part-${sha.slice(0, 16)}`);
    expect(partPathOf({ destPath: dest, sha256: sha })).toBe(deterministicPartPath(dest, sha));
  });

  test('resumes from the on-disk offset and commits on completion', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(4096);
    const d: SinkDescriptor = {
      destPath: join(dir, 'pkg.tgz'),
      sha256: sha256(bytes),
      totalBytes: bytes.byteLength,
    };
    const first = await sink.write(d, bodyOf(bytes.subarray(0, 1000)), {
      offset: 0,
      contentLength: 1000,
    });
    expect(first).toMatchObject({ ok: true, receivedBytes: 1000, complete: false });
    expect((await sink.status(d)).receivedBytes).toBe(1000);

    const second = await sink.write(d, bodyOf(bytes.subarray(1000)), {
      offset: 1000,
      contentLength: bytes.byteLength - 1000,
    });
    expect(second).toMatchObject({ ok: true, complete: true });
    const committed = await sink.commit(d);
    expect(committed).toMatchObject({ ok: true, bytes: bytes.byteLength });
    expect(readFileSync(d.destPath)).toEqual(Buffer.from(bytes));
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('a wrong offset reports the real received size and keeps the .part', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(512);
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz'), sha256: sha256(bytes) };
    await sink.write(d, bodyOf(bytes.subarray(0, 100)), { offset: 0, contentLength: 512 });
    const res = await sink.write(d, bodyOf(bytes.subarray(300)), { offset: 300 });
    expect(res).toEqual({ ok: false, code: 'offset_mismatch', receivedBytes: 100 });
    expect(existsSync(partPathOf(d))).toBe(true);
  });

  test('a short body is a broken link: keep the .part, report incomplete', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(2048);
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz'), sha256: sha256(bytes) };
    const res = await sink.write(d, bodyOf(bytes.subarray(0, 700)), {
      offset: 0,
      contentLength: 2048,
    });
    expect(res).toEqual({ ok: false, code: 'incomplete', receivedBytes: 700 });
    expect(existsSync(partPathOf(d))).toBe(true);
    expect((await sink.status(d)).receivedBytes).toBe(700);
  });

  test('a full-length body with a bad digest deletes the .part', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(256);
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz'), sha256: sha256(payload(255)) };
    const res = await sink.write(d, bodyOf(bytes), { offset: 0, contentLength: 256 });
    expect(res).toEqual({ ok: false, code: 'checksum_mismatch' });
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('a corrupt prefix of the right length re-aligns the sender at zero', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(1024);
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz'), sha256: sha256(bytes) };
    const partPath = partPathOf(d);
    writeFileSync(partPath, new Uint8Array(400));
    const res = await sink.write(d, bodyOf(bytes.subarray(400)), { offset: 400 });
    // 前缀重算能读满 400 字节，所以这里走的是「摘要不符 → 删半成品」而不是偏移不符
    expect(res).toEqual({ ok: false, code: 'checksum_mismatch' });
    expect(existsSync(partPath)).toBe(false);
  });

  test('exceeding maxBytes drops the .part', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(4096);
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz'), maxBytes: 1024 };
    const res = await sink.write(d, bodyOf(bytes), { offset: 0 });
    expect(res).toEqual({ ok: false, code: 'too_large' });
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('an externally cancelled write keeps the .part and reports aborted', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = { destPath: join(dir, 'pkg.tgz') };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload(64));
      },
    });
    const holder: { cancel: (() => void) | null } = { cancel: null };
    const pending = sink.write(d, body, {
      offset: 0,
      contentLength: 1024,
      registerCancel: (fn) => {
        holder.cancel = fn;
      },
    });
    await Bun.sleep(1);
    holder.cancel?.();
    expect(await pending).toEqual({ ok: false, code: 'aborted' });
    expect(existsSync(partPathOf(d))).toBe(true);
  });

  test('sweep removes expired parts only', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const fresh = join(dir, 'a.tgz.part-0123456789abcdef');
    const stale = join(dir, 'b.tgz.part-fedcba9876543210');
    writeFileSync(fresh, new Uint8Array(4));
    writeFileSync(stale, new Uint8Array(4));
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    expect(await sink.sweep(dir, Date.now())).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('ResumableSink ranged mode', () => {
  test('out-of-order ranges reassemble and verify the whole-file digest', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(3000);
    const d: SinkDescriptor = {
      destPath: join(dir, 'big.bin'),
      key: 'job-1',
      mode: 'ranged',
      totalBytes: 3000,
      sha256: sha256(bytes),
    };
    const tail = await sink.write(d, bodyOf(bytes.subarray(1500)), {
      offset: 1500,
      contentLength: 1500,
    });
    expect(tail).toMatchObject({ ok: true, complete: false, receivedBytes: 1500 });
    const state = await sink.status(d);
    expect(state.ranges).toEqual([{ offset: 1500, length: 1500 }]);

    const head = await sink.write(d, bodyOf(bytes.subarray(0, 1500)), {
      offset: 0,
      contentLength: 1500,
    });
    expect(head).toMatchObject({ ok: true, complete: true, receivedBytes: 3000 });
    expect((await sink.commit(d)).ok).toBe(true);
    expect(readFileSync(d.destPath)).toEqual(Buffer.from(bytes));
  });

  test('concurrent ranges racing to create the .part do not zero each other', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(4096);
    const d: SinkDescriptor = {
      destPath: join(dir, 'race.bin'),
      key: 'job-race',
      mode: 'ranged',
      totalBytes: 4096,
      sha256: sha256(bytes),
    };
    const results = await Promise.all(
      [0, 1024, 2048, 3072].map((offset) =>
        sink.write(d, bodyOf(bytes.subarray(offset, offset + 1024)), {
          offset,
          contentLength: 1024,
        })
      )
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await sink.status(d)).complete).toBe(true);
    expect((await sink.commit(d)).ok).toBe(true);
    expect(readFileSync(d.destPath)).toEqual(Buffer.from(bytes));
  });

  test('a truncated range records what landed and reports incomplete', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(1000);
    const d: SinkDescriptor = {
      destPath: join(dir, 'big.bin'),
      key: 'job-2',
      mode: 'ranged',
      totalBytes: 1000,
    };
    const res = await sink.write(d, bodyOf(bytes.subarray(500, 700)), {
      offset: 500,
      contentLength: 500,
    });
    expect(res).toEqual({ ok: false, code: 'incomplete', receivedBytes: 200 });
    expect((await sink.status(d)).ranges).toEqual([{ offset: 500, length: 200 }]);
  });

  test('a range beyond the declared total is rejected', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'big.bin'),
      key: 'job-3',
      mode: 'ranged',
      totalBytes: 100,
    };
    expect(await sink.write(d, bodyOf(payload(50)), { offset: 80, contentLength: 50 })).toEqual({
      ok: false,
      code: 'too_large',
    });
  });

  test('a complete file with the wrong digest is discarded', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'big.bin'),
      key: 'job-4',
      mode: 'ranged',
      totalBytes: 64,
      sha256: sha256(payload(63)),
    };
    const res = await sink.write(d, bodyOf(payload(64)), { offset: 0, contentLength: 64 });
    expect(res).toEqual({ ok: false, code: 'checksum_mismatch' });
    expect(existsSync(partPathOf(d))).toBe(false);
    expect((await sink.status(d)).receivedBytes).toBe(0);
  });
});

describe('ResumableSink review regressions', () => {
  function partialWriteSpy(perCall: number) {
    const realOpen = fsPromises.open;
    return spyOn(fsPromises, 'open').mockImplementation(async (path, flags, mode) => {
      const fh = await realOpen(path as string, flags as string, mode as number);
      return {
        write: async (buf: Uint8Array, off: number, len: number, pos?: number | null) =>
          perCall > 0
            ? fh.write(buf, off, Math.min(perCall, len), pos ?? null)
            : { bytesWritten: 0, buffer: buf },
        truncate: (len?: number) => fh.truncate(len),
        close: () => fh.close(),
      } as unknown as Awaited<ReturnType<typeof realOpen>>;
    });
  }

  test('短写循环补齐：分两次落盘的区间字节完整（乱序模式）', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(4);
    const d: SinkDescriptor = {
      destPath: join(dir, 'short.bin'),
      key: 'short-ranged',
      mode: 'ranged',
      totalBytes: 4,
      sha256: sha256(bytes),
    };
    const spy = partialWriteSpy(2);
    try {
      const res = await sink.write(d, bodyOf(bytes), { offset: 0, contentLength: 4 });
      expect(res).toMatchObject({ ok: true, complete: true, receivedBytes: 4 });
    } finally {
      spy.mockRestore();
    }
    expect((await sink.commit(d)).ok).toBe(true);
    expect(readFileSync(d.destPath)).toEqual(Buffer.from(bytes));
  });

  test('短写循环补齐：追加模式同样按实际写入字节推进摘要', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const bytes = payload(6);
    const d: SinkDescriptor = {
      destPath: join(dir, 'short-append.tgz'),
      sha256: sha256(bytes),
      totalBytes: 6,
    };
    const spy = partialWriteSpy(2);
    try {
      const res = await sink.write(d, bodyOf(bytes), { offset: 0, contentLength: 6 });
      expect(res).toMatchObject({ ok: true, complete: true, receivedBytes: 6 });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(partPathOf(d))).toEqual(Buffer.from(bytes));
  });

  test('一个字节都写不进去算 IO 错误，不记成已收', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'stuck.bin'),
      key: 'stuck',
      mode: 'ranged',
      totalBytes: 4,
    };
    const spy = partialWriteSpy(0);
    try {
      expect(await sink.write(d, bodyOf(payload(4)), { offset: 0, contentLength: 4 })).toEqual({
        ok: false,
        code: 'io_error',
      });
    } finally {
      spy.mockRestore();
    }
    expect((await sink.status(d)).receivedBytes).toBe(0);
  });

  test('与在写区间重叠的写入被拒，已确认的字节不被改写', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'overlap.bin'),
      key: 'overlap',
      mode: 'ranged',
      totalBytes: 8,
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array([1, 1, 1, 1]));
        await held;
        controller.close();
      },
    });
    const first = sink.write(d, slow, { offset: 0, contentLength: 4 });
    await Bun.sleep(5);
    expect(await sink.write(d, bodyOf(new Uint8Array([9, 9])), { offset: 2 })).toEqual({
      ok: false,
      code: 'conflict',
    });
    release();
    expect(await first).toMatchObject({ ok: true, receivedBytes: 4 });
    // 已确认的区间同样不可再写
    expect(await sink.write(d, bodyOf(new Uint8Array([9, 9])), { offset: 2 })).toEqual({
      ok: false,
      code: 'conflict',
    });
    // 不相交的缺口照常接受
    expect(
      await sink.write(d, bodyOf(new Uint8Array([2, 2, 2, 2])), { offset: 4, contentLength: 4 })
    ).toMatchObject({ ok: true, complete: true });
    expect((await sink.commit(d)).ok).toBe(true);
    expect(readFileSync(d.destPath)).toEqual(Buffer.from([1, 1, 1, 1, 2, 2, 2, 2]));
  });

  test('落位排空在写的流，并封存后续写入', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'seal.bin'),
      key: 'seal',
      mode: 'ranged',
      totalBytes: 8,
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array([1, 1, 1, 1]));
        await held;
        controller.close();
      },
    });
    const first = sink.write(d, slow, { offset: 4, contentLength: 4 }).then((r) => {
      finished = true;
      return r;
    });
    await Bun.sleep(5);
    await sink.write(d, bodyOf(new Uint8Array([2, 2, 2, 2])), { offset: 0, contentLength: 4 });
    const committing = sink.commit(d);
    await Bun.sleep(5);
    expect(finished).toBe(false);
    release();
    await first;
    expect(await committing).toMatchObject({ ok: true, committed: true, skipped: false });
    expect(await sink.write(d, bodyOf(new Uint8Array([3])), { offset: 0 })).toEqual({
      ok: false,
      code: 'sealed',
    });
  });

  test('overwrite 落位直接改名盖过去；重复落位幂等且不误删目标', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const dest = join(dir, 'dest.bin');
    writeFileSync(dest, Buffer.from('old-content'));
    const d: SinkDescriptor = {
      destPath: dest,
      key: 'ow',
      mode: 'ranged',
      totalBytes: 3,
    };
    await sink.write(d, bodyOf(new Uint8Array([7, 7, 7])), { offset: 0, contentLength: 3 });
    expect(await sink.commit(d)).toMatchObject({ ok: true, committed: true, skipped: false });
    expect(readFileSync(dest)).toEqual(Buffer.from([7, 7, 7]));
    // 第二次 commit 返回同一个结论，目标文件仍在
    expect(await sink.commit(d)).toMatchObject({ ok: true, committed: true });
    expect(readFileSync(dest)).toEqual(Buffer.from([7, 7, 7]));
  });

  test('skip 落位在目标已存在时原子跳过，不动目标也不留半成品', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const dest = join(dir, 'keep.bin');
    const d: SinkDescriptor = { destPath: dest, key: 'skip', mode: 'ranged', totalBytes: 3 };
    await sink.write(d, bodyOf(new Uint8Array([7, 7, 7])), { offset: 0, contentLength: 3 });
    writeFileSync(dest, Buffer.from('other'));
    expect(await sink.commit(d, { onConflict: 'skip' })).toMatchObject({
      ok: true,
      committed: false,
      skipped: true,
    });
    expect(readFileSync(dest)).toEqual(Buffer.from('other'));
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('skip 落位在目标不存在时正常落地', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'fresh.bin'),
      key: 'skip-fresh',
      mode: 'ranged',
      totalBytes: 2,
    };
    await sink.write(d, bodyOf(new Uint8Array([5, 6])), { offset: 0, contentLength: 2 });
    expect(await sink.commit(d, { onConflict: 'skip' })).toMatchObject({
      ok: true,
      committed: true,
      skipped: false,
    });
    expect(readFileSync(d.destPath)).toEqual(Buffer.from([5, 6]));
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('位图落盘失败按可重试 IO 错误上报，区间不算已收', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'sidecar.bin'),
      key: 'sidecar',
      mode: 'ranged',
      totalBytes: 4,
    };
    const realWriteFile = fsPromises.writeFile;
    const spy = spyOn(fsPromises, 'writeFile').mockImplementation(async (target, data, options) => {
      if (String(target).includes('.rx')) throw new Error('ENOSPC');
      return realWriteFile(target as string, data as string, options as undefined);
    });
    try {
      expect(await sink.write(d, bodyOf(payload(4)), { offset: 0, contentLength: 4 })).toEqual({
        ok: false,
        code: 'io_error',
      });
    } finally {
      spy.mockRestore();
    }
    expect((await sink.status(d)).receivedBytes).toBe(0);
  });

  test('位图整份原子发布，不留临时文件', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'atomic.bin'),
      key: 'atomic',
      mode: 'ranged',
      totalBytes: 6,
    };
    await sink.write(d, bodyOf(payload(3)), { offset: 0, contentLength: 3 });
    const sidecar = `${partPathOf(d)}.rx`;
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(`${sidecar}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual([[0, 3]]);
  });

  test('会话信号 abort 立刻停止读 body 并掐掉源流', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'cancel.bin'),
      key: 'cancel',
      mode: 'ranged',
      totalBytes: 8,
    };
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = sink.write(d, body, { offset: 0, contentLength: 8, signal: controller.signal });
    await Bun.sleep(5);
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: 'aborted' });
    expect(cancelled).toBe(true);
  });

  test('已 abort 的信号直接拒绝写入，不开文件也不读 body', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'pre-cancel.bin'),
      key: 'pre-cancel',
      mode: 'ranged',
      totalBytes: 4,
    };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await sink.write(d, body, { offset: 0, signal: controller.signal })).toEqual({
      ok: false,
      code: 'aborted',
    });
    expect(cancelled).toBe(true);
    expect(existsSync(partPathOf(d))).toBe(false);
  });

  test('写失败提前退出时同样掐掉源流', async () => {
    const dir = tempDir();
    const sink = new ResumableSink();
    const d: SinkDescriptor = {
      destPath: join(dir, 'io-cancel.bin'),
      key: 'io-cancel',
      mode: 'ranged',
      totalBytes: 4,
    };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const spy = partialWriteSpy(0);
    try {
      expect(await sink.write(d, body, { offset: 0, contentLength: 4 })).toEqual({
        ok: false,
        code: 'io_error',
      });
    } finally {
      spy.mockRestore();
    }
    expect(cancelled).toBe(true);
  });
});
