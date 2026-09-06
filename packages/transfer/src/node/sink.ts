// 可续传的落盘接收端：`.part` + 偏移校验 + 截断判定 + 完成时校验摘要 + rename 落位。
// 泛化自 `apps/gateway/src/system/upgrade-staging.ts` 与 `upgrade.ts` 的收包主循环，
// 追加模式（streams=1）保持它们的全部语义，另加乱序区间写入模式供并行推送使用。

import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { coveredBytes, rangesCover } from '../ranges';
import type { ByteRange, ReceivedState } from '../types';
import {
  PART_TTL_MS,
  deterministicPartPath,
  fileSizeOrZero,
  readReceivedRanges,
  recordReceivedRange,
  removeReceivedRanges,
  sweepPartFiles,
} from './sink-state';
import { hashFilePrefix, sha256File } from './source';

export { PART_TTL_MS, deterministicPartPath, sweepPartFiles } from './sink-state';

export type SinkMode = 'append' | 'ranged';

export interface SinkDescriptor {
  /** 收满后落位的最终路径。 */
  destPath: string;
  /** 内容寻址键；缺省用 sha256，两者都没有就退回 destPath（同目标只能有一份半成品）。 */
  key?: string;
  /** 总字节数；追加模式下可省（升级推包只知道摘要不知道大小）。 */
  totalBytes?: number;
  sha256?: string;
  mode?: SinkMode;
  /** 硬上限，超过即判定为恶意/错配，删除半成品。 */
  maxBytes?: number;
  /** 落位后的权限，默认 0600。 */
  fileMode?: number;
}

export type SinkFailure =
  | { ok: false; code: 'offset_mismatch'; receivedBytes: number }
  | { ok: false; code: 'too_large' }
  | { ok: false; code: 'incomplete'; receivedBytes: number }
  | { ok: false; code: 'checksum_mismatch' }
  | { ok: false; code: 'aborted' }
  | { ok: false; code: 'invalid' }
  | { ok: false; code: 'io_error' };

export type SinkWriteResult =
  | { ok: true; receivedBytes: number; complete: boolean; digest: string | null }
  | SinkFailure;

export interface SinkWriteOptions {
  offset?: number;
  /**
   * 本次请求声明的字节数（content-length）。链路被 RST 时请求体往往「干净地结束」而不是报错，
   * 只有拿它对一下才分得清「传完了但内容坏了」与「传到一半断了」。
   */
  contentLength?: number;
  /** 本次写入允许接收的最大字节数；超出即判为越界（body 比声明的长）。 */
  maxWriteBytes?: number;
  /** 供调用方在外部顶掉这次写入（如同一目标的新请求到达）。 */
  registerCancel?: (cancel: () => void) => void;
}

export function partPathOf(d: SinkDescriptor): string {
  return deterministicPartPath(d.destPath, d.key ?? d.sha256 ?? d.destPath);
}

function modeOf(d: SinkDescriptor): SinkMode {
  return d.mode ?? 'append';
}

function limitOf(d: SinkDescriptor): number {
  const caps = [d.maxBytes, d.totalBytes].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  );
  return caps.length > 0 ? Math.min(...caps) : Number.POSITIVE_INFINITY;
}

/** 追加模式的已收字节就是 `.part` 长度；乱序模式读旁挂位图。 */
export async function readSinkState(d: SinkDescriptor): Promise<ReceivedState> {
  const partPath = partPathOf(d);
  if (modeOf(d) === 'ranged') {
    const ranges = fileSizeOrZero(partPath) > 0 ? await readReceivedRanges(partPath) : [];
    const received = coveredBytes(ranges);
    const total = d.totalBytes ?? 0;
    return { receivedBytes: received, ranges, complete: rangesCover(total, ranges) };
  }
  const size = fileSizeOrZero(partPath);
  const complete = d.totalBytes !== undefined && size === d.totalBytes && size > 0;
  return {
    receivedBytes: size,
    ranges: size > 0 ? [{ offset: 0, length: size }] : [],
    complete,
  };
}

type WriteTally = { bytes: number; aborted: boolean; failed: boolean; overflow: boolean };

async function pumpBody(
  body: ReadableStream<Uint8Array>,
  opts: SinkWriteOptions,
  sink: (chunk: Uint8Array) => Promise<void>,
  limit: number
): Promise<WriteTally> {
  const reader = body.getReader();
  const tally: WriteTally = { bytes: 0, aborted: false, failed: false, overflow: false };
  opts.registerCancel?.(() => {
    tally.aborted = true;
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (tally.bytes + value.byteLength > limit) {
        tally.overflow = true;
        break;
      }
      await sink(value);
      tally.bytes += value.byteLength;
    }
  } catch {
    tally.failed = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return tally;
}

/** 落盘接收端。无状态（除了旁挂位图），同一进程内共用一个实例即可。 */
export class ResumableSink {
  status(d: SinkDescriptor): Promise<ReceivedState> {
    return readSinkState(d);
  }

  async write(
    d: SinkDescriptor,
    body: ReadableStream<Uint8Array>,
    opts: SinkWriteOptions = {}
  ): Promise<SinkWriteResult> {
    const partPath = partPathOf(d);
    await mkdir(dirname(partPath), { recursive: true, mode: 0o700 }).catch(() => {});
    return modeOf(d) === 'ranged'
      ? this.writeRanged(d, partPath, body, opts)
      : this.writeAppend(d, partPath, body, opts);
  }

  private async writeAppend(
    d: SinkDescriptor,
    partPath: string,
    body: ReadableStream<Uint8Array>,
    opts: SinkWriteOptions
  ): Promise<SinkWriteResult> {
    const limit = limitOf(d);
    const hash = d.sha256 ? createHash('sha256') : null;
    const resumed = await resumeAppend(partPath, opts.offset ?? 0, limit, hash);
    if (!resumed.ok) return resumed.failure;
    const offset = resumed.offset;

    let fh: Awaited<ReturnType<typeof open>> | null = null;
    let tally: WriteTally;
    try {
      fh = await open(partPath, offset > 0 ? 'a' : 'w', 0o600);
      const handle = fh;
      tally = await pumpBody(
        body,
        opts,
        async (chunk) => {
          hash?.update(chunk);
          await handle.write(chunk);
        },
        Math.min(limit - offset, opts.maxWriteBytes ?? Number.POSITIVE_INFINITY)
      );
      await fh.close();
      fh = null;
    } catch {
      await fh?.close().catch(() => {});
      return { ok: false, code: 'io_error' };
    }
    if (tally.overflow) {
      await rm(partPath, { force: true }).catch(() => {});
      return { ok: false, code: 'too_large' };
    }
    if (tally.aborted) return { ok: false, code: 'aborted' };
    if (tally.failed) return { ok: false, code: 'io_error' };
    const received = offset + tally.bytes;
    if (truncated(tally.bytes, opts.contentLength)) {
      // 半截留在盘上等下一次续传，别把已经收到的十几兆一起扔掉。
      return { ok: false, code: 'incomplete', receivedBytes: received };
    }
    const complete = d.totalBytes === undefined ? true : received === d.totalBytes;
    return this.finish(d, partPath, received, complete, hash?.digest('hex') ?? null);
  }

  private async writeRanged(
    d: SinkDescriptor,
    partPath: string,
    body: ReadableStream<Uint8Array>,
    opts: SinkWriteOptions
  ): Promise<SinkWriteResult> {
    const total = d.totalBytes;
    if (total === undefined || total < 0) return { ok: false, code: 'invalid' };
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const declared = opts.contentLength;
    if (offset > total) return { ok: false, code: 'too_large' };
    if (declared !== undefined && offset + declared > total)
      return { ok: false, code: 'too_large' };

    let fh: Awaited<ReturnType<typeof open>> | null = null;
    let tally: WriteTally;
    try {
      fh = await openPreallocated(partPath, total);
      const handle = fh;
      let cursor = offset;
      tally = await pumpBody(
        body,
        opts,
        async (chunk) => {
          await handle.write(chunk, 0, chunk.byteLength, cursor);
          cursor += chunk.byteLength;
        },
        Math.min(
          total - offset,
          declared ?? Number.POSITIVE_INFINITY,
          opts.maxWriteBytes ?? Number.POSITIVE_INFINITY
        )
      );
      await fh.close();
      fh = null;
    } catch {
      await fh?.close().catch(() => {});
      return { ok: false, code: 'io_error' };
    }
    if (tally.overflow) return { ok: false, code: 'too_large' };
    const ranges = await recordReceivedRange(partPath, { offset, length: tally.bytes });
    if (tally.aborted) return { ok: false, code: 'aborted' };
    if (tally.failed) return { ok: false, code: 'io_error' };
    const received = coveredBytes(ranges);
    if (truncated(tally.bytes, declared)) {
      return { ok: false, code: 'incomplete', receivedBytes: received };
    }
    return this.finish(d, partPath, received, rangesCover(total, ranges), null);
  }

  /** 收满时校验摘要：不符说明内容坏了（不是链路断了），半成品必须删掉。 */
  private async finish(
    d: SinkDescriptor,
    partPath: string,
    receivedBytes: number,
    complete: boolean,
    digest: string | null
  ): Promise<SinkWriteResult> {
    if (!complete || !d.sha256) return { ok: true, receivedBytes, complete, digest };
    const actual = digest ?? (await sha256File(partPath));
    if (actual !== d.sha256.trim().toLowerCase()) {
      await this.discard(d);
      return { ok: false, code: 'checksum_mismatch' };
    }
    return { ok: true, receivedBytes, complete: true, digest: actual };
  }

  /** 落位：删掉旧目标 → rename → chmod。旁挂位图一并清掉。 */
  async commit(
    d: SinkDescriptor
  ): Promise<{ ok: true; path: string; bytes: number } | { ok: false; code: 'io_error' }> {
    const partPath = partPathOf(d);
    try {
      const bytes = fileSizeOrZero(partPath);
      await mkdir(dirname(d.destPath), { recursive: true }).catch(() => {});
      await rm(d.destPath, { force: true }).catch(() => {});
      await rename(partPath, d.destPath);
      await chmod(d.destPath, d.fileMode ?? 0o600).catch(() => {});
      await removeReceivedRanges(partPath);
      return { ok: true, path: d.destPath, bytes };
    } catch {
      return { ok: false, code: 'io_error' };
    }
  }

  async discard(d: SinkDescriptor): Promise<void> {
    const partPath = partPathOf(d);
    await rm(partPath, { force: true }).catch(() => {});
    await removeReceivedRanges(partPath);
  }

  /** TTL 清扫 + 开机孤儿扫描：同一入口，靠 `now` 与 `ttlMs` 区分。 */
  sweep(dir: string, now = Date.now(), ttlMs = PART_TTL_MS): Promise<number> {
    return sweepPartFiles(dir, now, ttlMs);
  }
}

/**
 * 打开预分配的 `.part`。缺文件时**只创建不截断**——并行写同一个半成品时用 `'w+'`
 * 会把别的流已经写好的字节清零（实测能稳定复现出整段 0）。
 */
async function openPreallocated(
  partPath: string,
  total: number
): Promise<Awaited<ReturnType<typeof open>>> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(partPath, 'r+', 0o600);
  } catch {
    const created = await open(partPath, 'a', 0o600);
    await created.close();
    fh = await open(partPath, 'r+', 0o600);
  }
  if (fileSizeOrZero(partPath) < total) await fh.truncate(total);
  return fh;
}

function truncated(received: number, expected?: number): boolean {
  if (expected === undefined || !Number.isFinite(expected) || expected <= 0) return false;
  return received < expected;
}

type ResumeOk = { ok: true; offset: number };
type ResumeFail = { ok: false; failure: SinkFailure };

/**
 * 落笔前的续传校验：`offset` 必须与 `.part` 当前长度严格一致，否则回真实偏移让推送端重新对齐；
 * 偏移为 0 一律从头覆写。需要摘要时把已落盘的前缀重新过一遍 hash。
 */
async function resumeAppend(
  partPath: string,
  rawOffset: number,
  limit: number,
  hash: ReturnType<typeof createHash> | null
): Promise<ResumeOk | ResumeFail> {
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  if (offset === 0) return { ok: true, offset: 0 };
  const onDisk = fileSizeOrZero(partPath);
  if (onDisk !== offset) {
    return { ok: false, failure: { ok: false, code: 'offset_mismatch', receivedBytes: onDisk } };
  }
  if (offset > limit) {
    await rm(partPath, { force: true }).catch(() => {});
    return { ok: false, failure: { ok: false, code: 'too_large' } };
  }
  if (hash && !(await hashFilePrefix(partPath, offset, hash))) {
    await rm(partPath, { force: true }).catch(() => {});
    return { ok: false, failure: { ok: false, code: 'offset_mismatch', receivedBytes: 0 } };
  }
  return { ok: true, offset };
}

export const resumableSink = new ResumableSink();

export type { ByteRange, ReceivedState };
