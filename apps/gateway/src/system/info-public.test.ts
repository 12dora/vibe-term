import { describe, expect, spyOn, test } from 'bun:test';
import { getSystemInfo } from './info-public';
import * as installInfo from './install-info';
import type { InstallInfo } from './install-info';

function install(deployment: InstallInfo['deployment']): InstallInfo {
  return {
    installedViaCli: true,
    installSource: 'cli',
    deployment,
    installDir: '/opt/vt',
    serviceName: 'vibeterm',
    cliVersion: '2.16.0',
    bunPath: process.execPath,
  };
}

describe('getSystemInfo deployment', () => {
  test('forwards openrc from install-info', () => {
    const spy = spyOn(installInfo, 'getInstallInfo').mockReturnValue(install('openrc'));
    try {
      expect(getSystemInfo().deployment).toBe('openrc');
    } finally {
      spy.mockRestore();
    }
  });

  test('deployment none keeps canSelfUpdate false even when installed via CLI', () => {
    const spy = spyOn(installInfo, 'getInstallInfo').mockReturnValue(install('none'));
    try {
      const info = getSystemInfo();
      expect(info.deployment).toBe('none');
      expect(info.canSelfUpdate).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
