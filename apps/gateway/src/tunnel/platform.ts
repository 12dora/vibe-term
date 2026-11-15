import { CLOUDFLARED_PINNED_VERSION, lookupCloudflaredPin } from './cloudflared-pins';

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
  const pin = lookupCloudflaredPin(platform, arch);
  if (pin) {
    return { url: pin.url, fileName: pin.fileName, tgz: pin.tgz };
  }
  const cfArch = arch === 'x64' ? 'amd64' : arch;
  const tgz = platform === 'darwin';
  const fileName = tgz
    ? `cloudflared-${platform}-${cfArch}.tgz`
    : `cloudflared-${platform}-${cfArch}`;
  return {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}/${fileName}`,
    fileName,
    tgz,
  };
}
