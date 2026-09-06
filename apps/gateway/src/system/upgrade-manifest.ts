// 暂存包的签名清单：推包方在推字节之前先把「这一版的 SHA256SUMS + 签名」交给节点，
// 节点用内嵌公钥当场验一遍并落成 sidecar。此后收字节、装包都以清单里的摘要为准，
// 推包方自报的 sha256 不再有任何权威性——入口被攻陷也换不掉要装的字节。

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ReleaseSignatureCode,
  ReleaseSignatureError,
  verifyReleaseSumsBundle,
} from './release-signature';

export type StagedPackageManifest = {
  version: string;
  /** 由已验签的 SHA256SUMS 给出的权威摘要。 */
  sha256: string;
  keyId: string;
  sums: string;
  sig: string;
};

export type ManifestVerifyResult =
  | { ok: true; manifest: StagedPackageManifest }
  | { ok: false; status: 400; code: 'BAD_REQUEST' | ReleaseSignatureCode };

/** 清单接口的返回：验签失败给 400 + 具体原因，落盘失败给 500。 */
export type PackageManifestResult =
  | { ok: true; version: string; sha256: string; keyId: string }
  | { ok: false; status: 400; code: 'BAD_REQUEST' | ReleaseSignatureCode }
  | { ok: false; status: 500; code: 'STAGE_FAILED' };

const MANIFEST_SUFFIX = '.manifest.json';
/** SHA256SUMS 原文 + 签名行的上限：正常只有几百字节，超出必是塞垃圾。 */
export const MANIFEST_MAX_BYTES = 64 * 1024;

export function stagedManifestPath(stagedDir: string, version: string): string {
  return join(stagedDir, `tmex-cli-${version}${MANIFEST_SUFFIX}`);
}

/** `tmex-cli-<ver>.manifest.json` → 版本号；其它文件名返回 null。 */
export function stagedManifestVersion(name: string): string | null {
  if (!name.startsWith('tmex-cli-') || !name.endsWith(MANIFEST_SUFFIX)) return null;
  const version = name.slice('tmex-cli-'.length, -MANIFEST_SUFFIX.length);
  return version.length > 0 ? version : null;
}

/**
 * 验一份推来的清单。签名必须存在且验得过——推包路径没有「老版本免签」这条退路，
 * 缺签名的包只可能来自不该信的推送方。
 */
export function verifyPackageManifest(input: {
  version: string;
  sums: unknown;
  sig: unknown;
}): ManifestVerifyResult {
  const { version } = input;
  if (typeof input.sums !== 'string' || typeof input.sig !== 'string') {
    return { ok: false, status: 400, code: 'BAD_REQUEST' };
  }
  const sums = input.sums;
  const sig = input.sig.trim();
  if (!sig || sums.length + sig.length > MANIFEST_MAX_BYTES) {
    return { ok: false, status: 400, code: sig ? 'BAD_REQUEST' : 'RELEASE_UNSIGNED' };
  }
  try {
    const verified = verifyReleaseSumsBundle(version, { sums, sig });
    if (!verified.sig || !verified.keyId) {
      return { ok: false, status: 400, code: 'RELEASE_UNSIGNED' };
    }
    return {
      ok: true,
      manifest: {
        version,
        sha256: verified.sha256,
        keyId: verified.keyId,
        sums: verified.sums,
        sig: verified.sig,
      },
    };
  } catch (error) {
    if (error instanceof ReleaseSignatureError) {
      return { ok: false, status: 400, code: error.code };
    }
    return { ok: false, status: 400, code: 'RELEASE_SIGNATURE_INVALID' };
  }
}

export async function writeStagedManifest(
  stagedDir: string,
  manifest: StagedPackageManifest
): Promise<void> {
  await writeFile(
    stagedManifestPath(stagedDir, manifest.version),
    `${JSON.stringify(manifest)}\n`,
    { mode: 0o600 }
  );
}

export async function removeStagedManifest(stagedDir: string, version: string): Promise<void> {
  await rm(stagedManifestPath(stagedDir, version), { force: true }).catch(() => {});
}

/**
 * 读回清单并重新验签。sidecar 也在盘上，只有再验一遍才挡得住「先推合法清单、
 * 再改盘上文件」的路子；任何异常一律当作没有清单。
 */
export function readStagedManifest(
  stagedDir: string,
  version: string
): StagedPackageManifest | null {
  const path = stagedManifestPath(stagedDir, version);
  if (!existsSync(path)) return null;
  let parsed: Partial<StagedPackageManifest>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StagedPackageManifest>;
  } catch {
    return null;
  }
  if (parsed.version !== version) return null;
  const verified = verifyPackageManifest({ version, sums: parsed.sums, sig: parsed.sig });
  return verified.ok ? verified.manifest : null;
}

/** 安装目录下的暂存包目录。 */
export function stagedPackageDir(installDir: string): string {
  return join(installDir, 'staging', 'staged');
}

/** 该版本是否已有可信清单，且清单摘要与盘上暂存包一致。 */
export function stagedManifestMatches(
  installDir: string,
  version: string,
  sha256: string
): boolean {
  const manifest = readStagedManifest(stagedPackageDir(installDir), version);
  return manifest !== null && manifest.sha256 === sha256;
}

/** 该版本清单里的权威摘要；没有可信清单返回 null。 */
export function stagedManifestSha256(installDir: string, version: string): string | null {
  return readStagedManifest(stagedPackageDir(installDir), version)?.sha256 ?? null;
}

export async function persistStagedManifest(
  installDir: string,
  manifest: StagedPackageManifest
): Promise<void> {
  const dir = stagedPackageDir(installDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeStagedManifest(dir, manifest);
}
