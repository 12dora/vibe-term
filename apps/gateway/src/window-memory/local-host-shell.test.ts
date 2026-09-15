import { describe, expect, test } from 'bun:test';

import { runLocalHostShell } from './local-host-shell';

describe('runLocalHostShell', () => {
  test('returns stdout of a fast command', async () => {
    const result = await runLocalHostShell('printf hi', { timeoutMs: 2000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
  });

  test('timeout of a foreground sleep resolves with 124 in under 1.5s', async () => {
    const started = Date.now();
    const result = await runLocalHostShell('sleep 30; echo done', { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe('timeout');
    expect(elapsed).toBeLessThan(1500);
  });
});
