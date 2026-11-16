// 安装来源的判定：install-meta 里记了什么就是什么，老 meta 没记按 CLI，压根没有 meta 是手动/容器。

import { describe, expect, test } from 'bun:test';
import {
  deploymentFromMeta,
  installSourceFromMeta,
  isManagedDeployment,
  openrcRemoteUninstallBlocked,
  openrcSelfUpdateBlocked,
} from './install-info';

describe('installSourceFromMeta', () => {
  test('没有 install-meta：手动部署或容器', () => {
    expect(installSourceFromMeta(null)).toBe('manual');
  });

  test('记了来源就照原样返回', () => {
    expect(installSourceFromMeta({ installSource: 'install-script' })).toBe('install-script');
    expect(installSourceFromMeta({ installSource: 'npx' })).toBe('npx');
    expect(installSourceFromMeta({ installSource: 'cli' })).toBe('cli');
  });

  test('老安装没记来源，或记了不认识的值：都按 CLI', () => {
    expect(installSourceFromMeta({ cliVersion: '1.1.40' })).toBe('cli');
    expect(installSourceFromMeta({ installSource: 'homebrew' })).toBe('cli');
  });
});

describe('deploymentFromMeta', () => {
  test('有 serviceManager 时按它映射，不看平台', () => {
    expect(deploymentFromMeta({ serviceManager: 'systemd-user', platform: 'darwin' })).toBe(
      'systemd'
    );
    expect(deploymentFromMeta({ serviceManager: 'launchd', platform: 'linux' })).toBe('launchd');
    expect(deploymentFromMeta({ serviceManager: 'openrc', platform: 'linux' })).toBe('openrc');
    expect(deploymentFromMeta({ serviceManager: 'none', platform: 'linux' })).toBe('none');
  });

  test('serviceMode=none 优先于 serviceManager 与平台启发式', () => {
    expect(
      deploymentFromMeta({
        serviceMode: 'none',
        serviceManager: 'openrc',
        platform: 'linux',
      })
    ).toBe('none');
    expect(deploymentFromMeta({ serviceMode: 'none', platform: 'darwin' })).toBe('none');
    expect(deploymentFromMeta({ serviceMode: 'managed', serviceManager: 'openrc' })).toBe('openrc');
  });

  test('老 meta 没有 serviceManager：按平台启发式', () => {
    expect(deploymentFromMeta({ platform: 'darwin' })).toBe('launchd');
    expect(deploymentFromMeta({ platform: 'linux' })).toBe('systemd');
    expect(deploymentFromMeta({ platform: 'win32' })).toBe('none');
    expect(deploymentFromMeta({}, 'linux')).toBe('systemd');
  });

  test('不认识的 serviceManager 回退平台启发式', () => {
    expect(deploymentFromMeta({ serviceManager: 'runit', platform: 'linux' })).toBe('systemd');
    expect(deploymentFromMeta({ serviceManager: 'runit', platform: 'darwin' })).toBe('launchd');
  });
});

describe('isManagedDeployment', () => {
  test('launchd / systemd / openrc 视为托管，none 不是', () => {
    expect(isManagedDeployment('launchd')).toBe(true);
    expect(isManagedDeployment('systemd')).toBe(true);
    expect(isManagedDeployment('openrc')).toBe(true);
    expect(isManagedDeployment('none')).toBe(false);
  });

  test('未知值按托管处理，避免旧客户端对新增枚举崩溃', () => {
    expect(isManagedDeployment('runit')).toBe(true);
  });
});

describe('OpenRC 非 root 的自更新与远程卸载闸门', () => {
  test('免密规则未就绪时禁止自更新；root 与非 OpenRC 不受影响', () => {
    expect(openrcSelfUpdateBlocked({ deployment: 'openrc' }, 1000)).toBe(true);
    const ready = { deployment: 'openrc' as const, openrcSudoers: true };
    expect(openrcSelfUpdateBlocked({ ...ready, openrcSudoers: false }, 1000)).toBe(true);
    expect(openrcSelfUpdateBlocked(ready, 1000)).toBe(false);
    expect(openrcSelfUpdateBlocked({ deployment: 'openrc' }, 0)).toBe(false);
    expect(openrcSelfUpdateBlocked({ deployment: 'systemd' }, 1000)).toBe(false);
  });

  test('非 root 的 OpenRC 节点一律不能远程卸载', () => {
    expect(openrcRemoteUninstallBlocked({ deployment: 'openrc' }, 1000)).toBe(true);
    expect(openrcRemoteUninstallBlocked({ deployment: 'openrc' }, 0)).toBe(false);
    expect(openrcRemoteUninstallBlocked({ deployment: 'systemd' }, 1000)).toBe(false);
  });
});
