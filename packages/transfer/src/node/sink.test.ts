import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'tmex-sink-test-'));
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
