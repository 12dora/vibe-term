import { describe, expect, test } from 'bun:test';
import { refreshServiceManager } from './service-manager-meta';

describe('refreshServiceManager', () => {
  test('--no-service installs stay none without probing', async () => {
    let probed = false;
    const detect = async () => {
      probed = true;
      return 'openrc' as const;
    };
    expect(await refreshServiceManager({ serviceMode: 'none' }, detect)).toBe('none');
    expect(probed).toBe(false);
  });

  test('managed installs take the freshly detected manager', async () => {
    const meta = { serviceMode: 'managed' as const, serviceManager: 'systemd-user' as const };
    expect(await refreshServiceManager(meta, async () => 'openrc')).toBe('openrc');
  });

  test('detection miss keeps the recorded manager', async () => {
    const meta = { serviceMode: 'managed' as const, serviceManager: 'openrc' as const };
    expect(await refreshServiceManager(meta, async () => 'none')).toBe('openrc');
    expect(await refreshServiceManager({ serviceMode: 'managed' }, async () => 'none')).toBe(
      undefined
    );
  });

  test('detection failure is treated as a miss', async () => {
    const meta = { serviceMode: 'managed' as const, serviceManager: 'openrc' as const };
    const detect = async (): Promise<'none'> => {
      throw new Error('boom');
    };
    expect(await refreshServiceManager(meta, detect)).toBe('openrc');
  });
});
