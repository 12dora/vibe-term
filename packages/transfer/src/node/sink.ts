// 可续传的落盘接收端：`.part` + 偏移校验 + 截断判定 + 完成时校验摘要 + rename 落位。
// 泛化自 `apps/gateway/src/system/upgrade-staging.ts` 与 `upgrade.ts` 的收包主循环，
// 追加模式（streams=1）保持它们的全部语义，另加乱序区间写入模式供并行推送使用。

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { chmod, link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { coveredBytes, rangesCover } from '../ranges';
import type { ByteRange, ReceivedState } from '../types';
import {
  type WriteToken,
  finishWrite,
  forgetPart,
  releaseWrite,
  reserveWrite,
  serializeCommit,
} from './part-gate';
import {
  PART_TTL_MS,
  deterministicPartPath,
  fileSizeOrZero,
  readReceivedRanges,
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
  | { ok: false; code: 'io_error' }
  /** 与另一条在写的流（或已确认的区间）重叠：退避后按新偏移重来即可。 */
  | { ok: false; code: 'conflict' }
  /** 半成品已落位封存，不再接受写入。 */
  | { ok: false; code: 'sealed' };

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
  /** 会话级取消：一 abort 就停止读 body 并尽快关掉文件句柄。 */
  signal?: AbortSignal;
}

/** 目标已存在时的落位策略；`skip` 在落位那一刻原子判定，不做「先查后改名」。 */
export type CommitOptions = { onConflict?: 'overwrite' | 'skip' };

export type CommitResult =
  | { ok: true; path: string; bytes: number; committed: boolean; skipped: boolean }
  | { ok: false; code: 'io_error' };

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

/**
 * `write(2)` 允许短写。按返回的 `bytesWritten` 推进游标，直到整块写完；
 * 一次都没推进说明设备出问题了，当 IO 错误抛出，绝不能把没写进去的字节记成已收。
 */
async function writeAll(
  handle: FileHandle,
  chunk: Uint8Array,
  position: number | null,
  onWritten: (slice: Uint8Array) => void
): Promise<void> {
  let done = 0;
  while (done < chunk.byteLength) {
    const remaining = chunk.byteLength - done;
    const res =
      position === null
        ? await handle.write(chunk, done, remaining)
        : await handle.write(chunk, done, remaining, position + done);
    const written = Math.max(0, Math.min(res.bytesWritten ?? 0, remaining));
    if (written === 0) throw new Error('sink: zero-length write');
    onWritten(chunk.subarray(done, done + written));
    done += written;
  }
}

async function cancelBody(body: ReadableStream<Uint8Array>): Promise<void> {
  await body.cancel().catch(() => {});
}

type SinkFn = (chunk: Uint8Array, advance: (n: number) => void) => Promise<void>;

async function pumpBody(
  body: ReadableStream<Uint8Array>,
  opts: SinkWriteOptions,
  sink: SinkFn,
  limit: number
): Promise<WriteTally> {
  const reader = body.getReader();
  const tally: WriteTally = { bytes: 0, aborted: false, failed: false, overflow: false };
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  const onAbort = (): void => {
    tally.aborted = true;
    cancel();
  };
  opts.registerCancel?.(onAbort);
  const signal = opts.signal;
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const advance = (n: number): void => {
    tally.bytes += n;
  };
  let drained = false;
  try {
    while (!tally.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value?.byteLength) continue;
      if (tally.bytes + value.byteLength > limit) {
        tally.overflow = true;
        break;
      }
      await sink(value, advance);
    }
  } catch {
    tally.failed = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // 提前退出必须把 body 掐掉，否则发送端会一直往一个没人读的流里灌。
    // 唯一的例外是越界：中途 cancel 源流会让 413 回不到发送端（见 upgrade 的 413 语义），
    // 这时靠调用方立刻回响应来让对端自己停。
    if (!drained && !tally.overflow) cancel();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return tally;
}

async function pumpToHandle(input: {
  openHandle: () => Promise<FileHandle>;
  body: ReadableStream<Uint8Array>;
  opts: SinkWriteOptions;
  limit: number;
  /** 定位写的起点；`null` 表示按文件当前位置追加。 */
  position: number | null;
  onWritten?: (slice: Uint8Array) => void;
}): Promise<WriteTally> {
  const { openHandle, body, opts, limit, position, onWritten } = input;
  if (opts.signal?.aborted) {
    await cancelBody(body);
    return { bytes: 0, aborted: true, failed: false, overflow: false };
  }
  let handle: FileHandle;
  try {
    handle = await openHandle();
  } catch {
    await cancelBody(body);
    return { bytes: 0, aborted: false, failed: true, overflow: false };
  }
  let cursor = position;
  const tally = await pumpBody(
    body,
    opts,
    async (chunk, advance) => {
      const base = cursor;
      await writeAll(handle, chunk, base, (slice) => {
        if (cursor !== null) cursor += slice.byteLength;
        onWritten?.(slice);
        advance(slice.byteLength);
      });
    },
    limit
  );
  try {
    await handle.close();
  } catch {
    tally.failed = true;
  }
  return tally;
}

/** 落盘接收端。无状态（除了旁挂位图与进程内的并发闸门），同一进程内共用一个实例即可。 */
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
    // 落笔前就否决的请求（偏移不符 / 区间冲突 / 已封存）不掐源流：调用方要立刻把状态码回给
    // 发送端，中途 cancel 会让响应回不去（与越界 413 同一个道理）。
    if (!resumed.ok) return resumed.failure;
    const offset = resumed.offset;
    const cap = Math.min(limit - offset, opts.maxWriteBytes ?? Number.POSITIVE_INFINITY);
    const reserved = await reserveWrite(partPath, { offset, length: cap }, false);
    if (!reserved.ok) return { ok: false, code: reserved.code };
    const tally = await this.runAppendWrite(
      partPath,
      body,
      opts,
      offset,
      cap,
      hash,
      reserved.token
    );
    if (tally.overflow) {
      await this.dropPart(partPath);
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

  private async runAppendWrite(
    partPath: string,
    body: ReadableStream<Uint8Array>,
    opts: SinkWriteOptions,
    offset: number,
    cap: number,
    hash: ReturnType<typeof createHash> | null,
    token: WriteToken
  ): Promise<WriteTally> {
    try {
      return await pumpToHandle({
        openHandle: () => open(partPath, offset > 0 ? 'a' : 'w', 0o600),
        body,
        opts,
        limit: cap,
        position: null,
        onWritten: (slice) => hash?.update(slice),
      });
    } finally {
      releaseWrite(token);
    }
  }

  private async writeRanged(
    d: SinkDescriptor,
    partPath: string,
    body: ReadableStream<Uint8Array>,
    opts: SinkWriteOptions
  ): Promise<SinkWriteResult> {
    const plan = rangedPlan(d, opts);
    // 同上：落笔前否决的请求保留源流，让调用方把状态码送达。
    if (!plan.ok) return plan.failure;
    const { offset, limit, total, declared } = plan;
    const reserved = await reserveWrite(partPath, { offset, length: limit }, true);
    if (!reserved.ok) return { ok: false, code: reserved.code };
    const tally = await pumpToHandle({
      openHandle: () => openPreallocated(partPath, total),
      body,
      opts,
      limit,
      position: offset,
    });
    let ranges: ByteRange[];
    try {
      // 位图没能持久化就等于这段字节不算数：报可重试的 IO 错误，让推送端重发。
      ranges = await finishWrite(reserved.token, { offset, length: tally.bytes });
    } catch {
      return { ok: false, code: 'io_error' };
    }
    if (tally.overflow) return { ok: false, code: 'too_large' };
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

  private async dropPart(partPath: string): Promise<void> {
    await rm(partPath, { force: true }).catch(() => {});
    await removeReceivedRanges(partPath);
    forgetPart(partPath);
  }

  /**
   * 落位。`overwrite` 直接 rename 盖过去（POSIX 上是原子替换，不存在「先删后建」的空窗）；
   * `skip` 用 `link` 抢占目标——已存在时 EEXIST 原子失败，不会误删别人刚落位的文件。
   * 同一半成品的重复落位是幂等的，且会先排空还在写的流。
   */
  commit(d: SinkDescriptor, opts: CommitOptions = {}): Promise<CommitResult> {
    const partPath = partPathOf(d);
    return serializeCommit(
      partPath,
      () => placePart(d, partPath, opts.onConflict ?? 'overwrite'),
      (result) => result.ok
    );
  }

  async discard(d: SinkDescriptor): Promise<void> {
    await this.dropPart(partPathOf(d));
  }

  /** TTL 清扫 + 开机孤儿扫描：同一入口，靠 `now` 与 `ttlMs` 区分。 */
  sweep(dir: string, now = Date.now(), ttlMs = PART_TTL_MS): Promise<number> {
    return sweepPartFiles(dir, now, ttlMs);
  }
}

async function placePart(
  d: SinkDescriptor,
  partPath: string,
  onConflict: 'overwrite' | 'skip'
): Promise<CommitResult> {
  try {
    const bytes = fileSizeOrZero(partPath);
    await mkdir(dirname(d.destPath), { recursive: true }).catch(() => {});
    if (onConflict === 'skip' && !(await linkNoClobber(partPath, d.destPath))) {
      await rm(partPath, { force: true });
      await removeReceivedRanges(partPath);
      return { ok: true, path: d.destPath, bytes, committed: false, skipped: true };
    }
    if (onConflict === 'skip') await rm(partPath, { force: true });
    else await rename(partPath, d.destPath);
    await chmod(d.destPath, d.fileMode ?? 0o600).catch(() => {});
    await removeReceivedRanges(partPath);
    return { ok: true, path: d.destPath, bytes, committed: true, skipped: false };
  } catch {
    return { ok: false, code: 'io_error' };
  }
}

/** `link` 在目标已存在时以 EEXIST 原子失败——这是唯一不带竞态的「不覆盖」落位方式。 */
async function linkNoClobber(partPath: string, destPath: string): Promise<boolean> {
  try {
    await link(partPath, destPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  }
}

type RangedPlan =
  | { ok: true; offset: number; limit: number; total: number; declared: number | undefined }
  | { ok: false; failure: SinkFailure };

function rangedPlan(d: SinkDescriptor, opts: SinkWriteOptions): RangedPlan {
  const total = d.totalBytes;
  if (total === undefined || total < 0)
    return { ok: false, failure: { ok: false, code: 'invalid' } };
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const declared = opts.contentLength;
  if (offset > total) return { ok: false, failure: { ok: false, code: 'too_large' } };
  if (declared !== undefined && offset + declared > total) {
    return { ok: false, failure: { ok: false, code: 'too_large' } };
  }
  const limit = Math.min(
    total - offset,
    declared ?? Number.POSITIVE_INFINITY,
    opts.maxWriteBytes ?? Number.POSITIVE_INFINITY
  );
  return { ok: true, offset, limit, total, declared };
}

/**
 * 打开预分配的 `.part`。缺文件时**只创建不截断**——并行写同一个半成品时用 `'w+'`
 * 会把别的流已经写好的字节清零（实测能稳定复现出整段 0）。
 */
async function openPreallocated(partPath: string, total: number): Promise<FileHandle> {
  let fh: FileHandle;
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
