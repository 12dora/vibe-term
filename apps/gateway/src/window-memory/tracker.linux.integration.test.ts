import { describe, expect, test } from 'bun:test';

import { parseSamplerOutput } from './sample-parser';
import { buildSamplerScript } from './sampler-script';

async function linuxUserSystemdAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const proc = Bun.spawn(['systemctl', '--user', 'show-environment'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const enabled = await linuxUserSystemdAvailable();

describe.skipIf(!enabled)('window-memory sampler (linux)', () => {
  test('samples the current process pid', async () => {
    const pid = process.pid;
    const script = buildSamplerScript([{ paneId: '%1', pid }]);
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const parsed = parseSamplerOutput(stdout);
    expect(parsed.limitsSupported).toBe(true);
    expect(parsed.reason).toBe('ok');
    expect(parsed.panes).toHaveLength(1);
    expect(parsed.panes[0]?.pid).toBe(pid);
    expect(parsed.panes[0]?.paneId).toBe('%1');
    expect(parsed.panes[0]?.source === 'cgroup' || parsed.panes[0]?.source === 'rss').toBe(true);
    expect(parsed.panes[0]?.current).toBeGreaterThanOrEqual(0);
  });
});
