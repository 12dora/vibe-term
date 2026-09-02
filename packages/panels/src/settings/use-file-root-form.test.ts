import { describe, expect, test } from 'bun:test';

import type { Device, FileRootDto } from '@tmex/shared';

import type { FileRootDeviceGroup } from './file-root-query';
import {
  collectFileRootDeviceOptions,
  isFileRootFormSubmittable,
  resolveFileRootFormDeviceId,
  resolveFileRootFormEnabled,
} from './use-file-root-form';

const devices = [
  { id: 'd1', name: 'laptop', type: 'local' },
  { id: 'd2', name: 'server', type: 'ssh' },
] as Device[];

describe('isFileRootFormSubmittable', () => {
  test('新增模式要求绝对路径且已选设备', () => {
    expect(isFileRootFormSubmittable({ deviceId: 'd1', path: '/srv', enabled: true }, false)).toBe(
      true
    );
    expect(isFileRootFormSubmittable({ deviceId: '', path: '/srv', enabled: true }, false)).toBe(
      false
    );
    expect(isFileRootFormSubmittable({ deviceId: 'd1', path: 'srv', enabled: true }, false)).toBe(
      false
    );
  });

  test('编辑模式不校验设备', () => {
    expect(isFileRootFormSubmittable({ deviceId: '', path: '/srv', enabled: true }, true)).toBe(
      true
    );
    expect(isFileRootFormSubmittable({ deviceId: '', path: '', enabled: true }, true)).toBe(false);
  });

  test('路径按 trim 后校验', () => {
    expect(
      isFileRootFormSubmittable({ deviceId: 'd1', path: '  /srv  ', enabled: true }, false)
    ).toBe(true);
    expect(isFileRootFormSubmittable({ deviceId: 'd1', path: '   ', enabled: true }, false)).toBe(
      false
    );
  });
});

describe('collectFileRootDeviceOptions', () => {
  test('未注入分组时直接用设备清单', () => {
    expect(collectFileRootDeviceOptions(undefined, devices)).toEqual(devices);
  });

  test('注入分组时摊平各组设备并忽略 devices', () => {
    const groups: FileRootDeviceGroup[] = [
      { label: 'local', devices: [{ id: 'g1', name: 'here' }] },
      { label: 'remote', devices: [{ id: 'g2', name: 'there', type: 'ssh' }] },
    ];
    expect(collectFileRootDeviceOptions(groups, devices)).toEqual([
      { id: 'g1', name: 'here' },
      { id: 'g2', name: 'there', type: 'ssh' },
    ]);
  });
});

describe('resolveFileRootFormDeviceId', () => {
  const root = { id: 'r1', deviceId: 'd2', path: '/srv' } as FileRootDto;

  test('单设备模式新增时强制用锁定设备', () => {
    expect(resolveFileRootFormDeviceId(undefined, 'd1')).toBe('d1');
  });

  test('编辑模式始终跟随 root 自己的设备', () => {
    expect(resolveFileRootFormDeviceId(root, 'd1')).toBe('d2');
  });

  test('未锁定时新增从空开始', () => {
    expect(resolveFileRootFormDeviceId(undefined, undefined)).toBe('');
  });
});

describe('resolveFileRootFormEnabled', () => {
  test('新增默认启用', () => {
    expect(resolveFileRootFormEnabled(undefined)).toBe(true);
  });

  test('编辑沿用 root 当前的启用态', () => {
    expect(resolveFileRootFormEnabled({ enabled: false } as FileRootDto)).toBe(false);
    expect(resolveFileRootFormEnabled({ enabled: true } as FileRootDto)).toBe(true);
  });
});
