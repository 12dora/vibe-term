import { afterEach, describe, expect, test } from 'bun:test';
import {
  MANAGED_EXTERNALLY,
  canSelfUpdate,
  getManagementMode,
  getUpdateOwner,
  isManagedExternally,
  lockManagedRuntime,
  resetManagedRuntimeForTests,
} from './managed';

afterEach(() => {
  resetManagedRuntimeForTests();
});

describe('managed runtime lock', () => {
  test('默认非管理态可自更新（prod+cli）', () => {
    expect(getManagementMode()).toBe('none');
    expect(getUpdateOwner()).toBe('self');
    expect(isManagedExternally()).toBe(false);
    expect(canSelfUpdate(true, true)).toBe(true);
  });

  test('lock 后用户 env 不能覆盖', () => {
    lockManagedRuntime({ managementMode: 'companion-cli', updateOwner: 'companion' });
    process.env.TMEX_MANAGEMENT_MODE = 'none';
    process.env.TMEX_UPDATE_OWNER = 'self';
    expect(getManagementMode()).toBe('companion-cli');
    expect(getUpdateOwner()).toBe('companion');
    expect(isManagedExternally()).toBe(true);
    expect(canSelfUpdate(true, true)).toBe(false);
  });

  test('二次 lock 保持首次值', () => {
    lockManagedRuntime({ managementMode: 'app', updateOwner: 'app' });
    lockManagedRuntime({ managementMode: 'companion-cli', updateOwner: 'companion' });
    expect(getManagementMode()).toBe('app');
    expect(getUpdateOwner()).toBe('app');
  });

  test('app 模式强制 update_owner=app', () => {
    lockManagedRuntime({ managementMode: 'app', updateOwner: 'self' });
    expect(getUpdateOwner()).toBe('app');
  });

  test('managed_externally 常量稳定', () => {
    expect(MANAGED_EXTERNALLY).toBe('managed_externally');
  });
});
