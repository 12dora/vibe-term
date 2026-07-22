import { describe, expect, test } from 'bun:test';

import {
  MANAGED_NODE_ENV_DEFINE,
  MANAGED_TARGETS,
  createManagedCompileEnvironment,
  hostTarget,
  outfileName,
} from './build-managed';

describe('managed gateway compile environment', () => {
  test('forces production even when the caller inherited development', () => {
    const env = createManagedCompileEnvironment({
      NODE_ENV: 'development',
      TMEX_MANAGED_FORCE_CROSS: '1',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.TMEX_MANAGED_FORCE_CROSS).toBe('1');
    expect(MANAGED_NODE_ENV_DEFINE).toBe('process.env.NODE_ENV="production"');
  });
});

describe('managed gateway target contract', () => {
  test('defines Windows x64 baseline and ARM64 targets', () => {
    expect(MANAGED_TARGETS).toContain('bun-windows-x64-baseline');
    expect(MANAGED_TARGETS).toContain('bun-windows-arm64');
    expect(hostTarget('win32', 'x64')).toBe('bun-windows-x64-baseline');
    expect(hostTarget('win32', 'arm64')).toBe('bun-windows-arm64');
  });

  test('derives the executable suffix from the target rather than the build host', () => {
    expect(outfileName('bun-windows-x64-baseline')).toBe(
      'tmex-gateway-managed-windows-x64-baseline.exe'
    );
    expect(outfileName('bun-windows-arm64')).toBe('tmex-gateway-managed-windows-arm64.exe');
    expect(outfileName('bun-darwin-arm64')).toBe('tmex-gateway-managed-darwin-arm64');
    expect(outfileName('bun-linux-x64')).toBe('tmex-gateway-managed-linux-x64');
  });
});
