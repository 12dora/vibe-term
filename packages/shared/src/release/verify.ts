// 发布包 SHA256SUMS 解析与校验（Node-only：依赖 node:crypto / node:path）。
// 不从浏览器侧 barrel 导出；调用方按相对路径 import（同 env/load-env）。
// 缺校验和一律拒绝（fail-closed）；版本门槛由调用方决定是否再包一层兼容分支。

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/;

export type ReleaseChecksumSums = {
  hex: string | null;
  missing: boolean;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseSha256Sums(text: string, fileName: string): string | null {
  const want = basename(fileName);
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(SUM_LINE);
    if (!match) continue;
    if (basename(match[2]) === want) return match[1].toLowerCase();
  }
  return null;
}

export function checksumStatus(
  sums: ReleaseChecksumSums,
  actualSha256: string
): 'missing' | 'mismatch' | 'ok' {
  if (sums.missing || !sums.hex) return 'missing';
  if (actualSha256.toLowerCase() !== sums.hex) return 'mismatch';
  return 'ok';
}

/** 缺条目或摘要不符一律抛错。错误文案需同时覆盖网关既有测试的两种 404 措辞。 */
export function assertReleaseChecksum(
  actualSha256: string,
  sums: ReleaseChecksumSums,
  fileName: string
): void {
  const status = checksumStatus(sums, actualSha256);
  if (status === 'missing') {
    throw new Error(
      'Release SHA256SUMS is missing; tarball integrity is unverified. Refusing to continue.'
    );
  }
  if (status === 'mismatch') {
    throw new Error(`Release tarball sha256 mismatch for ${fileName}.`);
  }
}

export function assertReleaseIntegrityBytes(
  bytes: Uint8Array,
  sums: ReleaseChecksumSums,
  fileName: string
): void {
  assertReleaseChecksum(sha256Hex(bytes), sums, fileName);
}
