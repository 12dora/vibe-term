// 设备种类：Device.type（local/ssh）× 节点上下文（self/远端）→ 四种展示种类与文案。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import { deviceDisplayKind, deviceKindLabel, isRemoteDeviceKind } from './device-node-context';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
});

describe('deviceDisplayKind', () => {
  test('本机上下文直接沿用设备类型', () => {
    expect(deviceDisplayKind('local', { isSelf: true })).toBe('local');
    expect(deviceDisplayKind('ssh', { isSelf: true })).toBe('ssh');
  });

  test('远端节点上下文加上 node 前缀', () => {
    expect(deviceDisplayKind('local', { isSelf: false })).toBe('nodeLocal');
    expect(deviceDisplayKind('ssh', { isSelf: false })).toBe('nodeSsh');
  });
});

describe('isRemoteDeviceKind', () => {
  test('只有 node* 两种算远端', () => {
    expect(isRemoteDeviceKind('local')).toBe(false);
    expect(isRemoteDeviceKind('ssh')).toBe(false);
    expect(isRemoteDeviceKind('nodeLocal')).toBe(true);
    expect(isRemoteDeviceKind('nodeSsh')).toBe(true);
  });
});

describe('deviceKindLabel', () => {
  test('本机两种', () => {
    expect(deviceKindLabel(i18n.t, 'local')).toBe('本地设备');
    expect(deviceKindLabel(i18n.t, 'ssh')).toBe('SSH 设备');
  });

  test('远端两种说「远程…」，节点名已在分组头上，不再重复', () => {
    expect(deviceKindLabel(i18n.t, 'nodeLocal')).toBe('远程本地设备');
    expect(deviceKindLabel(i18n.t, 'nodeSsh')).toBe('远程 SSH 设备');
  });
});
