// 暂存升级包的落盘细节：`.part` 命名、断点续传的偏移校验与前缀重算。
// 从 upgrade.ts 抽出来是因为这几步与升级状态机无关，且要单独讲清楚续传的判定。

import type { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseTarballName } from '@tmex/shared';

/** 断点续传的半成品保留期：超过这个时长没人接着传就当垃圾清掉。 */
export const STAGED_PART_TTL_MS = 24 * 60 * 60 * 1000;
const RESUME_HASH_CHUNK_BYTES = 1024 * 1024;

type Hash = ReturnType<typeof createHash>;

export type StagedPackageRecord = {
  version: string;
  sha256: string;
  path: string;
  bytes: number;
  stagedAt: string;
};

export type StagePackageResult =
  | { ok: true; version: string; sha256: string; bytes: number }
  | { ok: false; status: 400; code: 'PACKAGE_SHA256_MISMATCH' | 'BAD_REQUEST' }
  | { ok: false; status: 409; code: 'UPGRADE_IN_PROGRESS' }
  | { ok: false; status: 409; code: 'UPGRADE_OFFSET_MISMATCH'; receivedBytes: number }
  | { ok: false; status: 413; code: 'PACKAGE_TOO_LARGE' }
  | { ok: false; status: 500; code: 'PACKAGE_INCOMPLETE'; receivedBytes: number }
  | { ok: false; status: 500; code: 'STAGE_FAILED' };

/**
 * `PUT /api/system/upgrade/package` 的续传入参。
 * `offset` 缺省或 0 表示从头写；`expectedBytes` 是本次写完后 `.part` 应有的总长度
 * （offset + content-length）——链路被 RST 时请求体往往是「干净地结束」而不是报错，
 * 只有拿它对一下才分得清「传完了但包坏了」与「传到一半断了」。
 */
export type StagePackageOpts = { offset?: number; expectedBytes?: number };

export type StagedPackageStatusResult =
  | { ok: true; version: string; sha256: string; receivedBytes: number; complete: boolean }
  | { ok: false; status: 400; code: 'BAD_REQUEST' }
  | { ok: false; status: 500; code: 'STAGE_FAILED' };

/** `.part` 名按 (version, sha256) 确定，续传才找得回上一次写到哪。 */
export function stagedPartPath(stagedDir: string, version: string, sha256: string): string {
  return join(stagedDir, `${releaseTarballName(version)}.part-${sha256.slice(0, 16)}`);
}

export function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function stagedPartExpired(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > STAGED_PART_TTL_MS;
  } catch {
    return true;
  }
}

/** 声明了 content-length 却没收满：链路中断，不是包坏了。 */
export function truncatedTransfer(received: number, expected?: number): boolean {
  if (expected === undefined || !Number.isFinite(expected) || expected <= 0) return false;
  return received < expected;
}

/** 续传时把已落盘的前缀重新过一遍 hash：流式读，内存占用与包大小无关。 */
async function hashFilePrefix(path: string, length: number, hash: Hash): Promise<boolean> {
  try {
    const stream = createReadStream(path, {
      start: 0,
      end: length - 1,
      highWaterMark: RESUME_HASH_CHUNK_BYTES,
    });
    let read = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      read += buf.byteLength;
      hash.update(buf);
    }
    return read === length;
  } catch {
    return false;
  }
}

/**
 * 落笔前的续传校验：`offset` 必须与 `.part` 当前长度严格一致，否则回 409 并带上真实偏移，
 * 让推送端重新对齐；偏移为 0 一律从头覆写。
 */
export async function resumeStagedPart(
  partPath: string,
  rawOffset: number,
  maxBytes: number,
  hash: Hash
): Promise<{ ok: true; offset: number } | { ok: false; result: StagePackageResult }> {
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  if (offset === 0) return { ok: true, offset: 0 };
  const onDisk = fileSizeOrZero(partPath);
  if (onDisk !== offset) {
    return {
      ok: false,
      result: { ok: false, status: 409, code: 'UPGRADE_OFFSET_MISMATCH', receivedBytes: onDisk },
    };
  }
  if (offset > maxBytes) {
    await rm(partPath, { force: true }).catch(() => {});
    return { ok: false, result: { ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' } };
  }
  if (!(await hashFilePrefix(partPath, offset, hash))) {
    await rm(partPath, { force: true }).catch(() => {});
    return {
      ok: false,
      result: { ok: false, status: 409, code: 'UPGRADE_OFFSET_MISMATCH', receivedBytes: 0 },
    };
  }
  return { ok: true, offset };
}
