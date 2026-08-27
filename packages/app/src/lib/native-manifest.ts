import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const NATIVE_DATACHANNEL_VERSION = '0.33.1';
export const NATIVE_NAPI_VERSION = 8;
export const NATIVE_ADDON_FILENAME = 'node_datachannel.node';

export type NativePlatformId = 'darwin-arm64' | 'darwin-x64' | 'linux-x64-gnu' | 'linux-arm64-gnu';
export type NativeLibc = 'gnu' | 'glibc' | 'musl' | null;

export interface NativePin {
  platformId: NativePlatformId;
  npmPackage: `@node-datachannel/${NativePlatformId}`;
  version: string;
  tarballUrl: string;
  addonPath: string;
  integrity: string;
  napiVersion: number;
}

function pin(platformId: NativePlatformId, integrity: string): NativePin {
  return {
    platformId,
    npmPackage: `@node-datachannel/${platformId}`,
    version: NATIVE_DATACHANNEL_VERSION,
    tarballUrl: `https://registry.npmjs.org/@node-datachannel/${platformId}/-/${platformId}-${NATIVE_DATACHANNEL_VERSION}.tgz`,
    addonPath: `package/${NATIVE_ADDON_FILENAME}`,
    integrity,
    napiVersion: NATIVE_NAPI_VERSION,
  };
}

export const NATIVE_PINS: Record<NativePlatformId, NativePin> = {
  'darwin-arm64': pin(
    'darwin-arm64',
    'sha512-6reyGKzuYNzuJypm4KrpJVTpION39rZmLoqDNMiehTVuSZzV1yoYyLHCzJ9XNVpOViGdaUvAWXJTlHcoQOZtrw=='
  ),
  'darwin-x64': pin(
    'darwin-x64',
    'sha512-1zXH/E79bswwRfbUwilw9iPNCCI4GLul/xxsjx/H7jbPT9SeMgkHKcx7Emuw91NBeYYPvYSYwQ705h4FTVDxow=='
  ),
  'linux-x64-gnu': pin(
    'linux-x64-gnu',
    'sha512-0mTxq+0fYatoQ/7y9uMLDSRbnb0/Vrrl1Fhsuys8PfB06ft3IA8+6/qdFgRriHbCNkCkB3mSvWEIjCVjXuPr1A=='
  ),
  'linux-arm64-gnu': pin(
    'linux-arm64-gnu',
    'sha512-FriA+y9cKnr9shQaNz4AdqkaNb7yqBcj1U/OgAlLvJtY/mJLvRX7R3iic18aUA5BkMMK+wwqBI/0Al3brxdRAw=='
  ),
};

export interface LookupNativePinInput {
  platform: NodeJS.Platform | string;
  arch: string;
  libc: NativeLibc;
}

export function lookupNativePin(input: LookupNativePinInput): NativePin | null {
  const { platform, arch } = input;
  if (platform === 'darwin') {
    if (arch === 'arm64') return NATIVE_PINS['darwin-arm64'];
    if (arch === 'x64') return NATIVE_PINS['darwin-x64'];
    return null;
  }
  if (platform === 'linux') {
    if (input.libc === 'musl') return null;
    if (arch === 'x64') return NATIVE_PINS['linux-x64-gnu'];
    if (arch === 'arm64') return NATIVE_PINS['linux-arm64-gnu'];
    return null;
  }
  return null;
}

export interface LibcDetectDeps {
  platform?: NodeJS.Platform | string;
  readLdd?: () => string | null;
  readSelfExe?: () => Uint8Array | null;
  getReport?: () => {
    header?: { glibcVersionRuntime?: string };
    sharedObjects?: string[];
  } | null;
  execLibcCommand?: () => string | null;
}

function defaultReadLdd(): string | null {
  try {
    return readFileSync('/usr/bin/ldd', 'utf8').slice(0, 2048);
  } catch {
    return null;
  }
}

function defaultReadSelfExe(): Uint8Array | null {
  try {
    const fd = readFileSync('/proc/self/exe');
    return fd.subarray(0, 2048);
  } catch {
    return null;
  }
}

function interpreterPath(elf: Uint8Array): string | null {
  if (elf.length < 64) return null;
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46) return null;
  if (elf[4] !== 2 || elf[5] !== 1) return null;
  const offset = view.getUint32(32, true);
  const size = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  for (let i = 0; i < count; i += 1) {
    const headerOffset = offset + i * size;
    if (headerOffset + 36 > elf.length) return null;
    const type = view.getUint32(headerOffset, true);
    if (type === 3) {
      const fileOffset = view.getUint32(headerOffset + 8, true);
      const fileSize = view.getUint32(headerOffset + 32, true);
      if (fileOffset + fileSize > elf.length) return null;
      return new TextDecoder()
        .decode(elf.subarray(fileOffset, fileOffset + fileSize))
        .replace(/\0.*$/g, '');
    }
  }
  return null;
}

function defaultGetReport(): {
  header?: { glibcVersionRuntime?: string };
  sharedObjects?: string[];
} | null {
  if (process.platform !== 'linux' || !process.report) return null;
  const orig = process.report.excludeNetwork;
  process.report.excludeNetwork = true;
  try {
    return process.report.getReport() as {
      header?: { glibcVersionRuntime?: string };
      sharedObjects?: string[];
    };
  } finally {
    process.report.excludeNetwork = orig;
  }
}

function defaultExecLibcCommand(): string | null {
  try {
    return execFileSync(
      'sh',
      ['-c', 'getconf GNU_LIBC_VERSION 2>&1 || true; ldd --version 2>&1 || true'],
      {
        encoding: 'utf8',
        timeout: 3000,
      }
    );
  } catch {
    return null;
  }
}

function familyFromLdd(content: string): 'gnu' | 'musl' | null {
  if (content.includes('musl')) return 'musl';
  if (content.includes('GNU C Library') || content.includes('glibc')) return 'gnu';
  return null;
}

export function detectLibcFamily(deps: LibcDetectDeps = {}): 'gnu' | 'musl' | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return null;

  const readLdd = deps.readLdd ?? defaultReadLdd;
  const fromLdd = familyFromLdd(readLdd() ?? '');
  if (fromLdd) return fromLdd;

  const readSelfExe = deps.readSelfExe ?? defaultReadSelfExe;
  const interp = interpreterPath(readSelfExe() ?? new Uint8Array());
  if (interp?.includes('/ld-musl-')) return 'musl';
  if (interp?.includes('/ld-linux-')) return 'gnu';

  const report = (deps.getReport ?? defaultGetReport)();
  if (report?.header?.glibcVersionRuntime) return 'gnu';
  if (
    report?.sharedObjects?.some((item) => item.includes('libc.musl-') || item.includes('ld-musl-'))
  ) {
    return 'musl';
  }

  const commandOut = (deps.execLibcCommand ?? defaultExecLibcCommand)() ?? '';
  const [getconf, ldd1] = commandOut.split(/[\r\n]+/);
  if (getconf?.includes('glibc')) return 'gnu';
  if (ldd1?.includes('musl')) return 'musl';
  return null;
}

export function detectCurrentNativePin(
  input: {
    platform?: NodeJS.Platform | string;
    arch?: string;
    libc?: NativeLibc | 'detect';
  } = {}
): NativePin | null {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const libc =
    input.libc === undefined || input.libc === 'detect'
      ? detectLibcFamily({ platform })
      : input.libc;
  return lookupNativePin({ platform, arch, libc });
}

export function verifyNpmIntegrity(data: Uint8Array, integrity: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) return false;
  const actual = createHash('sha512').update(data).digest('base64');
  const expected = match[1];
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}
