import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { TunnelError } from './errors';

export const CLOUDFLARED_PINNED_VERSION = '2026.10.7';

export type CloudflaredPinId = 'linux-amd64' | 'linux-arm64' | 'darwin-amd64' | 'darwin-arm64';

export type CloudflaredPin = {
  id: CloudflaredPinId;
  version: string;
  fileName: string;
  url: string;
  tgz: boolean;
  downloadSha256: string;
  binarySha256: string;
};

const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}`;

function pin(
  id: CloudflaredPinId,
  fileName: string,
  tgz: boolean,
  downloadSha256: string,
  binarySha256: string
): CloudflaredPin {
  return {
    id,
    version: CLOUDFLARED_PINNED_VERSION,
    fileName,
    url: `${RELEASE_BASE}/${fileName}`,
    tgz,
    downloadSha256,
    binarySha256,
  };
}

export const CLOUDFLARED_PINS: Record<CloudflaredPinId, CloudflaredPin> = {
  'linux-amd64': pin(
    'linux-amd64',
    'cloudflared-linux-amd64',
    false,
    '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
    '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872'
  ),
  'linux-arm64': pin(
    'linux-arm64',
    'cloudflared-linux-arm64',
    false,
    '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
    '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775'
  ),
  // Cloudflare 发布体里 darwin .tgz 的 sha256 实际是解压后的二进制，不是归档本身。
  'darwin-amd64': pin(
    'darwin-amd64',
    'cloudflared-darwin-amd64.tgz',
    true,
    '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848',
    '5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86'
  ),
  'darwin-arm64': pin(
    'darwin-arm64',
    'cloudflared-darwin-arm64.tgz',
    true,
    '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd',
    '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12'
  ),
};

export function lookupCloudflaredPin(
  platform: NodeJS.Platform | string,
  arch: string
): CloudflaredPin | null {
  const cfArch = arch === 'x64' ? 'amd64' : arch;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  if (cfArch !== 'amd64' && cfArch !== 'arm64') return null;
  return CLOUDFLARED_PINS[`${platform}-${cfArch}`];
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256FileSync(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export async function sha256File(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return sha256Bytes(bytes);
}

export function hashesEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type ManagedBinaryVerdict = 'ok' | 'outdated' | 'mismatch';

export function classifyManagedBinary(
  hash: string | null,
  pin: CloudflaredPin,
  claimedVersion: string | null
): ManagedBinaryVerdict {
  if (hash && hashesEqual(hash, pin.binarySha256)) return 'ok';
  if (claimedVersion === pin.version) return 'mismatch';
  return 'outdated';
}

type HashCacheKey = { ino: string; mtimeMs: number; size: number; hash: string };

export class ManagedBinaryHashCache {
  private entry: HashCacheKey | null = null;

  constructor(private readonly digest: (path: string) => string = sha256FileSync) {}

  hash(path: string): string {
    const st = statSync(path);
    const ino = String(st.ino);
    const hit = this.entry;
    if (hit && hit.ino === ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.hash;
    }
    const hash = this.digest(path);
    this.entry = { ino, mtimeMs: st.mtimeMs, size: st.size, hash };
    return hash;
  }
}

export function assertPinnedManagedHash(hash: string, pin: CloudflaredPin): void {
  if (hashesEqual(hash, pin.binarySha256)) return;
  throw checksumMismatch();
}

export function checksumMismatch(): TunnelError {
  return new TunnelError('binary_checksum_mismatch', 'cloudflared binary checksum mismatch');
}
