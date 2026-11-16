import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/args';
import { maybeRestart, resolveRestartManager } from './restart';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const neverDetect = async (): Promise<never> => {
  throw new Error('must not probe');
};

describe('resolveRestartManager', () => {
  test('--no-service install never restarts a host service manager', async () => {
    const meta = { serviceMode: 'none' as const };
    expect(await resolveRestartManager('systemd-user', meta, neverDetect)).toBe('none');
  });

  test('recorded manager beats probing', async () => {
    const meta = { serviceMode: 'managed' as const, serviceManager: 'openrc' as const };
    expect(await resolveRestartManager(undefined, meta, neverDetect)).toBe('openrc');
  });

  test('old meta without a manager falls back to detection', async () => {
    const detect = async () => 'launchd' as const;
    expect(await resolveRestartManager(undefined, { serviceMode: 'managed' }, detect)).toBe(
      'launchd'
    );
  });
});

describe('maybeRestart', () => {
  test('returns manual for a --no-service install recorded in install-meta', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'vibeterm-restart-'));
    dirs.push(installDir);
    await writeFile(
      join(installDir, 'install-meta.json'),
      JSON.stringify({ serviceName: 'vibeterm', serviceMode: 'none', serviceManager: 'none' })
    );
    const outcome = await maybeRestart(parseArgs(['relay', 'join']), {}, installDir);
    expect(outcome).toBe('manual');
  });
});
