// 发行来源：本仓库（fork）不再走上游 npm 包，安装 / 升级 / 更新检查一律指向本仓库的 GitHub Releases。
// tarball 由 `npm pack` 产出并以 `vibeterm-cli-<version>.tgz` 作为 release 资产上传；tag 固定为 `v<version>`。
//
// 兼容：改名前的资产名是 `tmex-cli-<version>.tgz`。≤1.1.40 的节点按旧名下载 / 校验 / 解包，
// 因此发行仍同时上传旧名资产；本模块的读侧一律接受两种名字。

import { compareSemver } from '../semver';

export const RELEASE_REPO = '12dora/vibe-term';
export const RELEASE_REPO_URL = `https://github.com/${RELEASE_REPO}`;
export const RELEASE_API_LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/install.sh`;
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;

/** 同时匹配新旧资产名，捕获组 1 为版本号 */
export const RELEASE_TARBALL_NAME_PATTERN = /^(?:vibeterm|tmex)-cli-(\d+\.\d+\.\d+[^/]*)\.tgz$/;

/** 首个使用新资产名的版本；早于它的节点只认旧名 */
export const RELEASE_ASSET_RENAME_VERSION = '2.0.0';

export function releaseTag(version: string): string {
  return `v${version}`;
}

export function releaseTarballName(version: string): string {
  return `vibeterm-cli-${version}.tgz`;
}

/** 改名前的资产名，向 ≤1.1.40 的节点推包时使用 */
export function legacyReleaseTarballName(version: string): string {
  return `tmex-cli-${version}.tgz`;
}

/** 该版本合法的两个资产名：新名与改名前的旧名。发行同时上传两份。 */
export function releaseAssetNames(version: string): readonly [string, string] {
  return [releaseTarballName(version), legacyReleaseTarballName(version)];
}

/** 资产名是否是该版本的合法资产名之一。收到别人指定的资产名时必须先过这一关。 */
export function isReleaseAssetNameFor(version: string, name: string): boolean {
  return releaseAssetNames(version).some((asset) => asset === name);
}

/** 资产名（新旧皆可）解析出版本号，非资产名返回 null */
export function parseReleaseTarballName(name: string): string | null {
  return RELEASE_TARBALL_NAME_PATTERN.exec(name)?.[1] ?? null;
}

export function isReleaseTarballName(name: string): boolean {
  return RELEASE_TARBALL_NAME_PATTERN.test(name);
}

export function releaseTarballUrl(version: string): string {
  return `${RELEASE_REPO_URL}/releases/download/${releaseTag(version)}/${releaseTarballName(version)}`;
}

export function legacyReleaseTarballUrl(version: string): string {
  return `${RELEASE_REPO_URL}/releases/download/${releaseTag(version)}/${legacyReleaseTarballName(version)}`;
}

export function releaseApiUrl(version: string): string {
  return `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${releaseTag(version)}`;
}

/**
 * hub 向远端节点推包时选择资产名：目标节点版本低于 2.0.0 的只认旧名
 * （旧代码硬校验 `package.json.name === 'tmex-cli'`、`bin/tmex.js`、按精确文件名查 SHA256SUMS）。
 * 版本未知时保守使用旧名——旧名资产新旧节点都能处理。
 */
export function selectReleaseAssetForTarget(
  targetVersion: string | null | undefined,
  releaseVersion: string
): string {
  const cmp = targetVersion ? compareSemver(targetVersion, RELEASE_ASSET_RENAME_VERSION) : null;
  if (cmp === null || cmp < 0) return legacyReleaseTarballName(releaseVersion);
  return releaseTarballName(releaseVersion);
}
