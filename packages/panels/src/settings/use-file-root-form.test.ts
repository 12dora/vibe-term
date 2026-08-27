import { describe, expect, test } from 'bun:test';

import type { Device } from '@tmex/shared';

import type { FileRootDeviceGroup } from './file-root-query';
import { collectFileRootDeviceOptions, isFileRootFormSubmittable } from './use-file-root-form';

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
