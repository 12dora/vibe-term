import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  NATIVE_ADDON_FILENAME,
  NATIVE_DATACHANNEL_VERSION,
  NATIVE_NAPI_VERSION,
  NATIVE_PINS,
  type NativePlatformId,
  detectLibcFamily,
  lookupNativePin,
  verifyNpmIntegrity,
} from './native-manifest';

describe('NATIVE_PINS', () => {
  const platforms: NativePlatformId[] = [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64-gnu',
    'linux-arm64-gnu',
  ];

  test('pins v1 platforms to node-datachannel 0.33.1 with N-API 8', () => {
    for (const id of platforms) {
      const pin = NATIVE_PINS[id];
      expect(pin.platformId).toBe(id);
      expect(pin.version).toBe(NATIVE_DATACHANNEL_VERSION);
      expect(pin.version).toBe('0.33.1');
      expect(pin.napiVersion).toBe(NATIVE_NAPI_VERSION);
      expect(pin.napiVersion).toBe(8);
      expect(pin.npmPackage).toBe(`@node-datachannel/${id}`);
      expect(pin.addonPath).toBe(`package/${NATIVE_ADDON_FILENAME}`);
      expect(pin.integrity.startsWith('sha512-')).toBe(true);
      expect(pin.tarballUrl).toBe(
        `https://registry.npmjs.org/@node-datachannel/${id}/-/${id}-0.33.1.tgz`
      );
    }
  });
});

describe('lookupNativePin', () => {
  test('resolves darwin/linux gnu platforms', () => {
    expect(lookupNativePin({ platform: 'darwin', arch: 'arm64', libc: null })?.platformId).toBe(
      'darwin-arm64'
    );
    expect(lookupNativePin({ platform: 'darwin', arch: 'x64', libc: null })?.platformId).toBe(
      'darwin-x64'
    );
    expect(lookupNativePin({ platform: 'linux', arch: 'x64', libc: 'gnu' })?.platformId).toBe(
      'linux-x64-gnu'
    );
    expect(lookupNativePin({ platform: 'linux', arch: 'arm64', libc: 'glibc' })?.platformId).toBe(
      'linux-arm64-gnu'
    );
    expect(lookupNativePin({ platform: 'linux', arch: 'x64', libc: null })?.platformId).toBe(
      'linux-x64-gnu'
    );
  });

  test('rejects musl and unsupported platforms', () => {
    expect(lookupNativePin({ platform: 'linux', arch: 'x64', libc: 'musl' })).toBeNull();
    expect(lookupNativePin({ platform: 'linux', arch: 'arm64', libc: 'musl' })).toBeNull();
    expect(lookupNativePin({ platform: 'win32', arch: 'x64', libc: null })).toBeNull();
    expect(lookupNativePin({ platform: 'linux', arch: 'ia32', libc: 'gnu' })).toBeNull();
    expect(lookupNativePin({ platform: 'android', arch: 'arm64', libc: null })).toBeNull();
  });
});

describe('detectLibcFamily', () => {
  test('darwin has no libc family', () => {
    expect(detectLibcFamily({ platform: 'darwin' })).toBeNull();
  });

  test('linux musl via ldd content', () => {
    expect(
      detectLibcFamily({
        platform: 'linux',
        readLdd: () => 'musl libc (x86_64)\nVersion 1.2.4',
      })
    ).toBe('musl');
  });

  test('linux glibc via ldd content', () => {
    expect(
      detectLibcFamily({
        platform: 'linux',
        readLdd: () => 'ldd (GNU C Library) 2.39',
      })
    ).toBe('gnu');
  });
});

describe('verifyNpmIntegrity', () => {
  test('accepts matching sha512 and rejects mismatch', () => {
    const payload = new TextEncoder().encode('tmex-native-pin');
    const digest = createHash('sha512').update(payload).digest('base64');
    expect(verifyNpmIntegrity(payload, `sha512-${digest}`)).toBe(true);
    expect(
      verifyNpmIntegrity(
        payload,
        'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
      )
    ).toBe(false);
    expect(verifyNpmIntegrity(payload, 'sha256-not-used')).toBe(false);
  });
});
