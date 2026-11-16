import { describe, expect, test } from 'bun:test';
import {
  recordedManagerDeps,
  refreshServiceManager,
  refreshServiceMeta,
} from './service-manager-meta';

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

  test('a recorded manager wins over a session-dependent probe', async () => {
    let probed = false;
    const meta = { serviceMode: 'managed' as const, serviceManager: 'systemd-user' as const };
    const detect = async () => {
      probed = true;
      return 'openrc' as const;
    };
    expect(await refreshServiceManager(meta, detect)).toBe('systemd-user');
    expect(probed).toBe(false);
  });

  test('old meta without a manager gets the detected one', async () => {
    expect(await refreshServiceManager({ serviceMode: 'managed' }, async () => 'openrc')).toBe(
      'openrc'
    );
  });

  test('detection miss or failure leaves the field unset', async () => {
    expect(await refreshServiceManager({ serviceMode: 'managed' }, async () => 'none')).toBe(
      undefined
    );
    const detect = async (): Promise<'none'> => {
      throw new Error('boom');
    };
    expect(await refreshServiceManager({ serviceMode: 'managed' }, detect)).toBe(undefined);
  });
});

describe('refreshServiceMeta', () => {
  const base = { serviceMode: 'managed' as const, serviceName: 'vibeterm' };

  test('OpenRC records whether the NOPASSWD rule is ready', async () => {
    const names: string[] = [];
    const controlReady = async (name: string) => {
      names.push(name);
      return true;
    };
    expect(
      await refreshServiceMeta({ ...base, serviceManager: 'openrc' }, { controlReady })
    ).toEqual({ serviceManager: 'openrc', openrcSudoers: true });
    expect(names).toEqual(['vibeterm']);
  });

  test('probe failure records false', async () => {
    const controlReady = async () => {
      throw new Error('sudo gone');
    };
    expect(
      await refreshServiceMeta({ ...base, serviceManager: 'openrc' }, { controlReady })
    ).toEqual({ serviceManager: 'openrc', openrcSudoers: false });
  });

  test('other managers clear the OpenRC flag without probing', async () => {
    const controlReady = async () => {
      throw new Error('must not probe');
    };
    expect(
      await refreshServiceMeta({ ...base, serviceManager: 'systemd-user' }, { controlReady })
    ).toEqual({ serviceManager: 'systemd-user', openrcSudoers: undefined });
  });
});

describe('recordedManagerDeps', () => {
  test('only a recorded managed kind is forced', () => {
    expect(recordedManagerDeps('openrc')).toEqual({ manager: 'openrc' });
    expect(recordedManagerDeps('none')).toEqual({});
    expect(recordedManagerDeps(undefined)).toEqual({});
  });
});
