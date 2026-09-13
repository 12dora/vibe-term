import { describe, expect, test } from 'bun:test';
import { routeFetch, testContext } from './cli-test-harness';
import { command as system } from './system';

const INFO = {
  version: '2.1.0',
  deployment: 'launchd',
  baseVersion: '2.1.0',
};

const FACTS = {
  hostname: 'mbp',
  os: 'darwin',
  arch: 'arm64',
  kernel: '24.0.0',
  cpu: { count: 8, load1: 1.2, load5: 1.1, load15: 1.0 },
  mem: { totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
  disk: {
    root: { path: '/', totalBytes: 500 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 },
    home: { path: '/Users/me', totalBytes: 500 * 1024 ** 3, freeBytes: 80 * 1024 ** 3 },
  },
  tmux: { healthy: true, serverVersion: '3.5a', clientVersion: '3.5a' },
  docker: { present: true, socket: true },
  install: { deployment: 'launchd', installDir: '/opt/vt', cliVersion: '2.1.0' },
  memoryProfile: 'standard',
};

describe('vibeterm system info', () => {
  test('--json merges info and facts', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/system/info': () => INFO,
        'GET /api/system/facts': () => FACTS,
      }),
      { json: true }
    );
    await system.run(ctx, ['info']);
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(payload.version).toBe('2.1.0');
    expect(payload.os).toBe('darwin');
    expect(payload.memoryProfile).toBe('standard');
    expect(payload.docker).toEqual({ present: true, socket: true });
  });

  test('human output is key  value lines', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/system/info': () => INFO,
        'GET /api/system/facts': () => FACTS,
      })
    );
    await system.run(ctx, ['info']);
    const text = stdout.text();
    expect(text).toContain('os');
    expect(text).toContain('darwin');
    expect(text).toContain('disk /');
    expect(text).toContain('disk $HOME');
    expect(text).toContain('memory profile');
    expect(text).toContain('standard');
    expect(text).toContain('docker');
    expect(text).toContain('present');
  });
});
