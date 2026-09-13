// 暂存升级包的落盘细节。字节层（`.part` 命名、偏移校验、前缀重算、截断判定、落位）
// 已经统一到 `@vibeterm/transfer/node` 的 `ResumableSink`，这里只剩「升级语义 ↔ 引擎」的映射。

import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyReleaseTarballName, releaseTarballName } from '@vibeterm/shared';
import { coveredBytes } from '@vibeterm/transfer';
import {
  PART_TTL_MS,
  type SinkDescriptor,
  type SinkWriteResult,
  deterministicPartPath,
  fileExpired,
  fileSizeOrZero,
  partPathOf,
  rangesSidecarPath,
  readReceivedRanges,
  resumableSink,
} from '@vibeterm/transfer/node';
import { stagedManifestVersion } from './upgrade-manifest';

export { fileSizeOrZero };

/** 断点续传的半成品保留期：超过这个时长没人接着传就当垃圾清掉。 */
export const STAGED_PART_TTL_MS = PART_TTL_MS;

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
  | {
      ok: false;
      status: 409;
      code: 'UPGRADE_IN_PROGRESS' | 'UPGRADE_MANIFEST_MISMATCH' | 'UPGRADE_TOTAL_MISMATCH';
    }
  | { ok: false; status: 409; code: 'UPGRADE_OFFSET_MISMATCH'; receivedBytes: number }
  | { ok: false; status: 413; code: 'PACKAGE_TOO_LARGE' }
  | { ok: false; status: 500; code: 'PACKAGE_INCOMPLETE'; receivedBytes: number }
  | { ok: false; status: 500; code: 'STAGE_FAILED' };

/**
 * `PUT /api/system/upgrade/package` 的续传入参。
 * `offset` 缺省或 0 表示从头写；`expectedBytes` 是本次写完后 `.part` 应有的总长度
 * （offset + content-length）——链路被 RST 时请求体往往是「干净地结束」而不是报错，
 * 只有拿它对一下才分得清「传完了但包坏了」与「传到一半断了」。
 * `length` 与 `total` 成对出现时走乱序区间写入；缺任一则仍是追加（2.3.6 入口）。
 */
export type StagePackageOpts = {
  offset?: number;
  expectedBytes?: number;
  length?: number;
  total?: number;
};

/** 半开区间 `[start, end)`。 */
export type ReceivedRangePair = [number, number];

export type StagedPackageStatusResult =
  | {
      ok: true;
      version: string;
      sha256: string;
      receivedBytes: number;
      complete: boolean;
      ranges: ReceivedRangePair[];
    }
  | { ok: false; status: 400; code: 'BAD_REQUEST' }
  | { ok: false; status: 500; code: 'STAGE_FAILED' };

export type StageWriteOk = {
  ok: true;
  complete: boolean;
  receivedBytes: number;
  descriptor: SinkDescriptor;
};

export type StageWriteOutcome = StageWriteOk | Extract<StagePackageResult, { ok: false }>;

/** `.part` 名按 (version, sha256) 确定，续传才找得回上一次写到哪。 */
export function stagedPartPath(stagedDir: string, version: string, sha256: string): string {
  return deterministicPartPath(join(stagedDir, releaseTarballName(version)), sha256);
}

/** 乱序 `.part` 的 pinned `total`：首个 ranged PUT 写入，后续必须严格相等。 */
export function stagedTotalPath(partPath: string): string {
  return `${partPath}.total`;
}

export function stagedPartExpired(path: string, now: number): boolean {
  return fileExpired(path, now, STAGED_PART_TTL_MS);
}

export function isRangedStageOpts(opts?: StagePackageOpts): boolean {
  const length = opts?.length;
  const total = opts?.total;
  return (
    typeof length === 'number' &&
    Number.isFinite(length) &&
    length >= 0 &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total >= 0
  );
}

export function stagedSinkDescriptor(input: {
  stagedDir: string;
  version: string;
  sha256: string;
  maxBytes: number;
  ranged?: boolean;
  totalBytes?: number;
}): SinkDescriptor {
  const ranged = input.ranged === true;
  return {
    destPath: join(input.stagedDir, releaseTarballName(input.version)),
    key: input.sha256,
    sha256: input.sha256,
    maxBytes: input.maxBytes,
    totalBytes: ranged ? input.totalBytes : undefined,
    mode: ranged ? 'ranged' : 'append',
    fileMode: 0o600,
  };
}

export function rangePairsOf(
  ranges: ReadonlyArray<{ offset: number; length: number }>
): ReceivedRangePair[] {
  return ranges.map((r) => [r.offset, r.offset + r.length]);
}

export function rangesFromPairs(raw: unknown): Array<{ offset: number; length: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ offset: number; length: number }> = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const start = item[0];
    const end = item[1];
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const offset = Math.max(0, Math.trunc(start));
    const length = Math.max(0, Math.trunc(end) - offset);
    if (length > 0) out.push({ offset, length });
  }
  return out;
}

function clipRangesToTotal(
  ranges: ReadonlyArray<{ offset: number; length: number }>,
  total: number
): Array<{ offset: number; length: number }> {
  const out: Array<{ offset: number; length: number }> = [];
  for (const range of ranges) {
    if (range.offset >= total) continue;
    const length = Math.min(range.length, total - range.offset);
    if (length > 0) out.push({ offset: range.offset, length });
  }
  return out;
}

export async function readPinnedStagedTotal(partPath: string): Promise<number | null> {
  try {
    const n = Number((await readFile(stagedTotalPath(partPath), 'utf8')).trim());
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.trunc(n);
  } catch {
    return null;
  }
}

/** 进行中的 `.part` 进度。已落位的正式包由调用方查 sidecar，这里一律 `complete: false`。 */
export async function readStagedProgress(
  stagedDir: string,
  version: string,
  sha256: string
): Promise<{ receivedBytes: number; ranges: ReceivedRangePair[]; complete: false }> {
  const partPath = stagedPartPath(stagedDir, version, sha256);
  const pinned = await readPinnedStagedTotal(partPath);
  if (existsSync(rangesSidecarPath(partPath))) {
    const raw = await readReceivedRanges(partPath);
    const ranges = pinned === null ? raw : clipRangesToTotal(raw, pinned);
    return { receivedBytes: coveredBytes(ranges), ranges: rangePairsOf(ranges), complete: false };
  }
  const size = fileSizeOrZero(partPath);
  return {
    receivedBytes: size,
    ranges: size > 0 ? [[0, size]] : [],
    complete: false,
  };
}

function contentLengthOf(opts: StagePackageOpts | undefined, ranged: boolean): number | undefined {
  const offset = opts?.offset ?? 0;
  if (ranged) return opts?.length;
  if (opts?.expectedBytes === undefined) return undefined;
  return Math.max(0, opts.expectedBytes - offset);
}

function rangeAlreadyCovered(
  ranges: ReadonlyArray<{ offset: number; length: number }>,
  offset: number,
  length: number
): boolean {
  if (length <= 0) return ranges.length > 0 || offset === 0;
  const end = offset + length;
  return ranges.some((r) => r.offset <= offset && r.offset + r.length >= end);
}

function rejectRangedBounds(
  offset: number,
  length: number,
  total: number,
  maxBytes: number
): Extract<StagePackageResult, { ok: false }> | null {
  const span = offset + length;
  if (span > total) return { ok: false, status: 400, code: 'BAD_REQUEST' };
  if (total > maxBytes || span > maxBytes) {
    return { ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' };
  }
  return null;
}

async function pinStagedTotal(
  partPath: string,
  total: number
): Promise<Extract<StagePackageResult, { ok: false }> | null> {
  const path = stagedTotalPath(partPath);
  try {
    await writeFile(path, `${total}\n`, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      return { ok: false, status: 500, code: 'STAGE_FAILED' };
    }
  }
  const pinned = await readPinnedStagedTotal(partPath);
  if (pinned === null) return { ok: false, status: 500, code: 'STAGE_FAILED' };
  if (pinned !== total) return { ok: false, status: 409, code: 'UPGRADE_TOTAL_MISMATCH' };
  return null;
}

async function clearPinnedTotal(descriptor: SinkDescriptor): Promise<void> {
  await rm(stagedTotalPath(partPathOf(descriptor)), { force: true }).catch(() => {});
}

/**
 * 把一段请求体写入暂存 `.part`。乱序模式下区间收满会校验 sha256 并 `commit` 落位；
 * 追加模式不在这里改名，沿用调用方原来的提交路径。
 */
export async function writeStagedPackage(input: {
  stagedDir: string;
  version: string;
  sha256: string;
  maxBytes: number;
  body: ReadableStream<Uint8Array>;
  opts?: StagePackageOpts;
  registerCancel?: (cancel: () => void) => void;
}): Promise<StageWriteOutcome> {
  const ranged = isRangedStageOpts(input.opts);
  const offset = input.opts?.offset ?? 0;
  const length = contentLengthOf(input.opts, ranged);
  const total = ranged ? input.opts?.total : undefined;
  if (ranged && total !== undefined) {
    const rejected = rejectRangedBounds(offset, length ?? 0, total, input.maxBytes);
    if (rejected) return rejected;
  }
  await mkdir(input.stagedDir, { recursive: true, mode: 0o700 }).catch(() => {});
  const descriptor = stagedSinkDescriptor({
    stagedDir: input.stagedDir,
    version: input.version,
    sha256: input.sha256,
    maxBytes: input.maxBytes,
    ranged,
    totalBytes: total,
  });
  if (ranged && total !== undefined) {
    const pinned = await pinStagedTotal(partPathOf(descriptor), total);
    if (pinned) return pinned;
  }
  const written = await resumableSink.write(descriptor, input.body, {
    offset,
    contentLength: length,
    registerCancel: input.registerCancel,
  });
  if (!written.ok) return resolveWriteFailure(descriptor, written, offset, length ?? 0);
  if (written.complete && ranged) {
    const placed = await resumableSink.commit(descriptor);
    if (!placed.ok) return { ok: false, status: 500, code: 'STAGE_FAILED' };
    await clearPinnedTotal(descriptor);
    return {
      ok: true,
      complete: true,
      receivedBytes: placed.bytes,
      descriptor,
    };
  }
  return {
    ok: true,
    complete: written.complete,
    receivedBytes: written.receivedBytes,
    descriptor,
  };
}

async function resolveWriteFailure(
  descriptor: SinkDescriptor,
  written: Extract<SinkWriteResult, { ok: false }>,
  offset: number,
  length: number
): Promise<StageWriteOutcome> {
  if (written.code === 'sealed') {
    await clearPinnedTotal(descriptor);
    return { ok: true, complete: true, receivedBytes: descriptor.totalBytes ?? 0, descriptor };
  }
  if (written.code === 'conflict') {
    const state = await resumableSink.status(descriptor);
    if (!rangeAlreadyCovered(state.ranges, offset, length)) {
      return {
        ok: false,
        status: 409,
        code: 'UPGRADE_OFFSET_MISMATCH',
        receivedBytes: state.receivedBytes,
      };
    }
    if (state.complete && descriptor.mode === 'ranged') {
      const placed = await resumableSink.commit(descriptor);
      if (!placed.ok) return { ok: false, status: 500, code: 'STAGE_FAILED' };
      await clearPinnedTotal(descriptor);
      return { ok: true, complete: true, receivedBytes: placed.bytes, descriptor };
    }
    return {
      ok: true,
      complete: state.complete,
      receivedBytes: state.receivedBytes,
      descriptor,
    };
  }
  return stageFailureToResult(written);
}

/** 引擎的失败码 → 升级接口既有的 HTTP 语义。 */
export function stageFailureToResult(
  result: Extract<SinkWriteResult, { ok: false }>
): Extract<StagePackageResult, { ok: false }> {
  switch (result.code) {
    case 'offset_mismatch':
      return {
        ok: false,
        status: 409,
        code: 'UPGRADE_OFFSET_MISMATCH',
        receivedBytes: result.receivedBytes,
      };
    case 'too_large':
      return { ok: false, status: 413, code: 'PACKAGE_TOO_LARGE' };
    case 'incomplete':
      // 半截包留在盘上等下一次续传，别把已经收到的十几兆一起扔掉。
      return {
        ok: false,
        status: 500,
        code: 'PACKAGE_INCOMPLETE',
        receivedBytes: result.receivedBytes,
      };
    case 'checksum_mismatch':
      return { ok: false, status: 400, code: 'PACKAGE_SHA256_MISMATCH' };
    default:
      return { ok: false, status: 500, code: 'STAGE_FAILED' };
  }
}

/** 暂存目录里一个文件的身份：孤儿清理据此决定留还是删。 */
export type StagedEntry =
  | { kind: 'part' | 'other'; version: null }
  | { kind: 'manifest' | 'sidecar'; version: string }
  | { kind: 'tarball'; version: null };

/** 记录 sidecar 名由整包名派生（`.tgz` → `.json`）；旧名同样要认，否则孤儿清理会漏掉。 */
const SIDECAR_PREFIXES = ['vibeterm-cli-', 'tmex-cli-'];

function recordName(tarballName: string): string {
  return tarballName.replace(/\.tgz$/, '.json');
}

/** 暂存包的记录 sidecar 路径。 */
export function stagedRecordPath(stagedDir: string, version: string): string {
  return join(stagedDir, recordName(releaseTarballName(version)));
}

/** 改名前留在暂存目录里的记录 sidecar 路径。 */
export function legacyStagedRecordPath(stagedDir: string, version: string): string {
  return join(stagedDir, recordName(legacyReleaseTarballName(version)));
}

export function classifyStagedEntry(name: string): StagedEntry {
  if (name.includes('.part')) return { kind: 'part', version: null };
  const manifestVersion = stagedManifestVersion(name);
  if (manifestVersion) return { kind: 'manifest', version: manifestVersion };
  if (name.endsWith('.json')) {
    const prefix = SIDECAR_PREFIXES.find((p) => name.startsWith(p));
    const version = prefix ? name.slice(prefix.length, -'.json'.length) : '';
    return { kind: 'sidecar', version };
  }
  if (name.endsWith('.tgz')) return { kind: 'tarball', version: null };
  return { kind: 'other', version: null };
}

/**
 * 尽力而为地删掉过期暂存包的整包与记录 sidecar。**同步**完成：异步的 fire-and-forget
 * 会跑到「重试时新写的 sidecar」后面去，把刚写好的那份删掉。
 */
export function removeExpiredStagedFiles(
  stagedDir: string,
  version: string,
  tarballPath: string
): void {
  for (const path of [
    tarballPath,
    stagedRecordPath(stagedDir, version),
    legacyStagedRecordPath(stagedDir, version),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // 删不掉的残留留给下一轮孤儿清理
    }
  }
}
