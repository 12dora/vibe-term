// 发行来源：本仓库（fork）不再走上游 npm 包，安装 / 升级 / 更新检查一律指向本仓库的 GitHub Releases。
// tarball 由 `npm pack` 产出并以 `tmex-cli-<version>.tgz` 作为 release 资产上传；tag 固定为 `v<version>`。

export const RELEASE_REPO = '12dora/tmex-enhanced';
export const RELEASE_REPO_URL = `https://github.com/${RELEASE_REPO}`;
export const RELEASE_API_LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/install.sh`;
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;

export function releaseTag(version: string): string {
  return `v${version}`;
}

export function releaseTarballName(version: string): string {
  return `tmex-cli-${version}.tgz`;
}

export function releaseTarballUrl(version: string): string {
  return `${RELEASE_REPO_URL}/releases/download/${releaseTag(version)}/${releaseTarballName(version)}`;
}

export function releaseApiUrl(version: string): string {
  return `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${releaseTag(version)}`;
}
