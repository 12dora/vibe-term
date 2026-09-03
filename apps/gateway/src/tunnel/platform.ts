export function isTunnelPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return (platform === 'darwin' || platform === 'linux') && (arch === 'x64' || arch === 'arm64');
}

export function tunnelPlatformLabel(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`;
}

export function cloudflaredDownloadSpec(
  platform: NodeJS.Platform,
  arch: string
): { url: string; fileName: string; tgz: boolean } {
  const cfArch = arch === 'x64' ? 'amd64' : arch;
  const tgz = platform === 'darwin';
  const fileName = tgz
    ? `cloudflared-${platform}-${cfArch}.tgz`
    : `cloudflared-${platform}-${cfArch}`;
  return {
    url: `https://github.com/cloudflare/cloudflared/releases/latest/download/${fileName}`,
    fileName,
    tgz,
  };
}
