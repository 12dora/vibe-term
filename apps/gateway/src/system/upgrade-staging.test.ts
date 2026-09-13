import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partPathOf } from '@vibeterm/transfer/node';
import {
  isRangedStageOpts,
  readStagedProgress,
  stagedPartPath,
  stagedSinkDescriptor,
  stagedTotalPath,
  writeStagedPackage,
} from './upgrade-staging';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-stage-'));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function payload(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bytes[i] = (i * 17 + 3) & 0xff;
  return bytes;
}

describe('isRangedStageOpts', () => {
  test('requires both length and total', () => {
    expect(isRangedStageOpts()).toBe(false);
    expect(isRangedStageOpts({ offset: 0 })).toBe(false);
    expect(isRangedStageOpts({ length: 10 })).toBe(false);
    expect(isRangedStageOpts({ total: 10 })).toBe(false);
    expect(isRangedStageOpts({ length: 10, total: 20 })).toBe(true);
    expect(isRangedStageOpts({ length: 0, total: 0 })).toBe(true);
    expect(isRangedStageOpts({ length: -1, total: 20 })).toBe(false);
  });
});

describe('writeStagedPackage ranged', () => {
  async function writeRange(
    stagedDir: string,
    version: string,
    sha256: string,
    bytes: Uint8Array,
    offset: number,
    total: number
  ) {
    return writeStagedPackage({
      stagedDir,
      version,
      sha256,
      maxBytes: 1024 * 1024,
      body: bytesStream(bytes),
      opts: { offset, length: bytes.byteLength, total },
    });
  }

  test('out-of-order ranges reassemble, verify sha, and land the tarball', async () => {
    const stagedDir = tempDir();
    const bytes = payload(200);
    const hex = sha256Hex(bytes);
    const tail = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(80), 80, 200);
    expect(tail).toMatchObject({ ok: true, complete: false, receivedBytes: 120 });
    const mid = await readStagedProgress(stagedDir, '1.2.3', hex);
    expect(mid.ranges).toEqual([[80, 200]]);
    expect(mid.complete).toBe(false);

    const head = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 80), 0, 200);
    expect(head).toMatchObject({ ok: true, complete: true, receivedBytes: 200 });
    const dest = join(stagedDir, 'vibeterm-cli-1.2.3.tgz');
    expect(readFileSync(dest)).toEqual(Buffer.from(bytes));
    expect(existsSync(partPathOf((head as { descriptor: { destPath: string } }).descriptor))).toBe(
      false
    );
  });

  test('overlapping retry of an already-acked range is idempotent', async () => {
    const stagedDir = tempDir();
    const bytes = payload(100);
    const hex = sha256Hex(bytes);
    const first = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(40), 40, 100);
    expect(first).toMatchObject({ ok: true, complete: false, receivedBytes: 60 });
    const retry = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(40), 40, 100);
    expect(retry).toMatchObject({ ok: true, complete: false, receivedBytes: 60 });
    expect((await readStagedProgress(stagedDir, '1.2.3', hex)).ranges).toEqual([[40, 100]]);

    const head = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 40), 0, 100);
    expect(head).toMatchObject({ ok: true, complete: true, receivedBytes: 100 });
    expect(readFileSync(join(stagedDir, 'vibeterm-cli-1.2.3.tgz'))).toEqual(Buffer.from(bytes));
  });

  test('covering range with the wrong digest is fail-closed', async () => {
    const stagedDir = tempDir();
    const bytes = payload(64);
    const hex = sha256Hex(bytes);
    const bad = new Uint8Array(64).fill(9);
    const result = await writeRange(stagedDir, '1.2.3', hex, bad, 0, 64);
    expect(result).toEqual({ ok: false, status: 400, code: 'PACKAGE_SHA256_MISMATCH' });
    const descriptor = stagedSinkDescriptor({
      stagedDir,
      version: '1.2.3',
      sha256: hex,
      maxBytes: 1024,
      ranged: true,
      totalBytes: 64,
    });
    expect(existsSync(partPathOf(descriptor))).toBe(false);
    expect(await readStagedProgress(stagedDir, '1.2.3', hex)).toEqual({
      receivedBytes: 0,
      ranges: [],
      complete: false,
    });
  });

  test('concurrent disjoint ranges complete once', async () => {
    const stagedDir = tempDir();
    const bytes = payload(128);
    const hex = sha256Hex(bytes);
    const slices = [0, 32, 64, 96];
    const results = await Promise.all(
      slices.map((offset) =>
        writeRange(stagedDir, '1.2.3', hex, bytes.subarray(offset, offset + 32), offset, 128)
      )
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.some((r) => r.ok && r.complete)).toBe(true);
    expect(readFileSync(join(stagedDir, 'vibeterm-cli-1.2.3.tgz'))).toEqual(Buffer.from(bytes));
  });

  test('first ranged PUT pins total; a different total is rejected and file/ranges stay', async () => {
    const stagedDir = tempDir();
    const bytes = payload(8);
    const hex = sha256Hex(bytes);
    const first = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 4), 0, 8);
    expect(first).toMatchObject({ ok: true, complete: false, receivedBytes: 4 });
    const part = stagedPartPath(stagedDir, '1.2.3', hex);
    expect(readFileSync(stagedTotalPath(part), 'utf8').trim()).toBe('8');
    const beforeSize = statSync(part).size;
    const before = await readStagedProgress(stagedDir, '1.2.3', hex);
    expect(before.ranges).toEqual([[0, 4]]);

    const bad = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(4), 4, 16);
    expect(bad).toEqual({ ok: false, status: 409, code: 'UPGRADE_TOTAL_MISMATCH' });
    expect(await readStagedProgress(stagedDir, '1.2.3', hex)).toEqual(before);
    expect(statSync(part).size).toBe(beforeSize);
    expect(readFileSync(stagedTotalPath(part), 'utf8').trim()).toBe('8');

    const rest = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(4), 4, 8);
    expect(rest).toMatchObject({ ok: true, complete: true, receivedBytes: 8 });
    expect(readFileSync(join(stagedDir, 'vibeterm-cli-1.2.3.tgz'))).toEqual(Buffer.from(bytes));
  });

  test('range beyond total is 400 and does not write or pin', async () => {
    const stagedDir = tempDir();
    const bytes = payload(8);
    const hex = sha256Hex(bytes);
    const firstBeyond = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 4), 6, 8);
    expect(firstBeyond).toEqual({ ok: false, status: 400, code: 'BAD_REQUEST' });
    const part = stagedPartPath(stagedDir, '1.2.3', hex);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(stagedTotalPath(part))).toBe(false);

    await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 4), 0, 8);
    const before = await readStagedProgress(stagedDir, '1.2.3', hex);
    const beyond = await writeRange(stagedDir, '1.2.3', hex, bytes.subarray(0, 4), 6, 8);
    expect(beyond).toEqual({ ok: false, status: 400, code: 'BAD_REQUEST' });
    expect(await readStagedProgress(stagedDir, '1.2.3', hex)).toEqual(before);
    expect(readFileSync(stagedTotalPath(part), 'utf8').trim()).toBe('8');
  });
});
