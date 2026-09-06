// 发行包签名的本机校验点：不联网、不问上游，只用内嵌公钥判定一份 SHA256SUMS 是否可信。
//
// 被攻陷的入口 / hub 能改的只有它推给节点的字节和它自报的 sha256；SHA256SUMS 的签名
// 由发布流水线持有的私钥产出，改一个字节就验不过，离线节点也能独立拒绝。

import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import {
  RELEASE_SIGNING_KEYS,
  type ReleaseSigningKey,
  expectedTarballHash,
  parseSha256Sums,
  releaseSignatureRequired,
  releaseTarballName,
  verifyReleaseSums,
} from '@vibeterm/shared';
import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';

export type ReleaseSignatureCode =
  | 'RELEASE_UNSIGNED'
  | 'RELEASE_SIGNATURE_INVALID'
  | 'RELEASE_SUMS_INVALID';

export class ReleaseSignatureError extends Error {
  constructor(
    readonly code: ReleaseSignatureCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ReleaseSignatureError';
  }
}

let keysOverride: readonly ReleaseSigningKey[] | null = null;

/** 单测注入用的钥表；非 test 环境调用直接抛错，生产没有任何路径能换掉内嵌公钥。 */
export function setReleaseSigningKeysForTests(keys: readonly ReleaseSigningKey[] | null): void {
  if (readNodeEnv() !== 'test') {
    throw new Error('release signing keys can only be overridden in tests');
  }
  keysOverride = keys;
}

export function activeReleaseSigningKeys(): readonly ReleaseSigningKey[] {
  return keysOverride ?? RELEASE_SIGNING_KEYS;
}

/** 已通过签名校验的一份 SHA256SUMS，以及它给出的该版本 tarball 权威摘要。 */
export type VerifiedReleaseSums = {
  sums: string;
  /** 签名行；只有 `RELEASE_SIGNING_SINCE` 之前的老版本才允许为 null。 */
  sig: string | null;
  keyId: string | null;
  sha256: string;
};

/**
 * 校验 SHA256SUMS（可选带签名）并取出该版本 tarball 的摘要。
 * 有签名就必须验得过——签名坏了一律拒绝，不因为版本老而放行；
 * 没签名只对 `RELEASE_SIGNING_SINCE` 之前的版本容忍。
 */
export function verifyReleaseSumsBundle(
  version: string,
  bundle: { sums: string; sig: string | null },
  /** 要取摘要的资产名；缺省按「新名优先、回退旧名」查。向 <2.0.0 的节点推包时显式传旧名。 */
  assetName?: string
): VerifiedReleaseSums {
  const sig = bundle.sig?.trim() ? bundle.sig : null;
  let keyId: string | null = null;
  if (sig) {
    const verified = verifyReleaseSums(bundle.sums, sig, activeReleaseSigningKeys());
    if (!verified.ok) {
      throw new ReleaseSignatureError(
        'RELEASE_SIGNATURE_INVALID',
        `release ${version} signature rejected (${verified.reason}, key ${verified.keyId ?? '?'})`
      );
    }
    keyId = verified.keyId;
  } else if (releaseSignatureRequired(version)) {
    throw new ReleaseSignatureError(
      'RELEASE_UNSIGNED',
      `release ${version} has no SHA256SUMS.sig; refusing to continue`
    );
  }
  const sha256 = assetName
    ? (parseSha256Sums(bundle.sums).get(assetName) ?? null)
    : expectedTarballHash(bundle.sums, version);
  if (!sha256) {
    throw new ReleaseSignatureError(
      'RELEASE_SUMS_INVALID',
      `SHA256SUMS does not list ${assetName ?? releaseTarballName(version)}`
    );
  }
  return { sums: bundle.sums, sig, keyId, sha256 };
}

/** 推包给别的节点：必须是签过名的包，没有兼容旧版本这一说。 */
export function assertPushableRelease(version: string, release: { sig: string | null }): void {
  if (release.sig) return;
  throw new ReleaseSignatureError(
    'RELEASE_UNSIGNED',
    `release ${version} is unsigned; refusing to push it to other nodes`
  );
}

/** 缓存目录里与整包同名的签名 sidecar：`<tarball>.sig.json`。 */
export function releaseSigSidecarPath(tarballPath: string): string {
  return `${tarballPath}.sig.json`;
}

export type ReleaseSigSidecar = {
  version: string;
  sha256: string;
  keyId: string | null;
  sums: string;
  sig: string | null;
};

export async function writeReleaseSigSidecar(
  tarballPath: string,
  record: ReleaseSigSidecar
): Promise<void> {
  await writeFile(releaseSigSidecarPath(tarballPath), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

export async function removeReleaseSigSidecar(tarballPath: string): Promise<void> {
  await rm(releaseSigSidecarPath(tarballPath), { force: true }).catch(() => {});
}

/**
 * 读回缓存包的签名 sidecar 并重新验签：盘上的 sidecar 也可能被改，
 * 只有再验一遍才能把「缓存命中」和「首次下载」放在同一条信任线上。
 * 任何不一致都返回 null，由调用方当作没有缓存重新下载。
 */
export function readReleaseSigSidecar(
  tarballPath: string,
  version: string,
  sha256: string,
  assetName?: string
): VerifiedReleaseSums | null {
  const path = releaseSigSidecarPath(tarballPath);
  if (!existsSync(path)) return null;
  let parsed: Partial<ReleaseSigSidecar>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReleaseSigSidecar>;
  } catch {
    return null;
  }
  if (parsed.version !== version || typeof parsed.sums !== 'string') return null;
  const sig = typeof parsed.sig === 'string' ? parsed.sig : null;
  try {
    const verified = verifyReleaseSumsBundle(version, { sums: parsed.sums, sig }, assetName);
    return verified.sha256 === sha256 ? verified : null;
  } catch {
    return null;
  }
}
