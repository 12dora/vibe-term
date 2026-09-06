// 暂存升级包的落盘细节。字节层（`.part` 命名、偏移校验、前缀重算、截断判定、落位）
// 已经统一到 `@tmex/transfer/node` 的 `ResumableSink`，这里只剩「升级语义 ↔ 引擎」的映射。

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { releaseTarballName } from '@tmex/shared';
import {
  PART_TTL_MS,
  type SinkDescriptor,
  type SinkWriteResult,
  deterministicPartPath,
  fileExpired,
  fileSizeOrZero,
} from '@tmex/transfer/node';
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
  | { ok: false; status: 409; code: 'UPGRADE_IN_PROGRESS' | 'UPGRADE_MANIFEST_MISMATCH' }
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
  return deterministicPartPath(join(stagedDir, releaseTarballName(version)), sha256);
}

export function stagedPartExpired(path: string, now: number): boolean {
  return fileExpired(path, now, STAGED_PART_TTL_MS);
}

export function stagedSinkDescriptor(input: {
  stagedDir: string;
  version: string;
  sha256: string;
  maxBytes: number;
}): SinkDescriptor {
  return {
    destPath: join(input.stagedDir, releaseTarballName(input.version)),
    key: input.sha256,
    sha256: input.sha256,
    maxBytes: input.maxBytes,
    mode: 'append',
    fileMode: 0o600,
  };
}

/** 引擎的失败码 → 升级接口既有的 HTTP 语义。 */
export function stageFailureToResult(
  result: Extract<SinkWriteResult, { ok: false }>
): StagePackageResult {
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

export function classifyStagedEntry(name: string): StagedEntry {
  if (name.includes('.part')) return { kind: 'part', version: null };
  const manifestVersion = stagedManifestVersion(name);
  if (manifestVersion) return { kind: 'manifest', version: manifestVersion };
  if (name.endsWith('.json')) {
    const version = name.startsWith('tmex-cli-')
      ? name.slice('tmex-cli-'.length, -'.json'.length)
      : '';
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
  for (const path of [tarballPath, join(stagedDir, `tmex-cli-${version}.json`)]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // 删不掉的残留留给下一轮孤儿清理
    }
  }
}
