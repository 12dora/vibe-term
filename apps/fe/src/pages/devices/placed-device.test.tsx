// 被单独放置的设备：状态判定（节点不可用 / 列表未到 / 设备已删）与占位渲染，
// 外加顶栏「新建文件夹」注册表与拖拽预览用的设备名缓存。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Device, DeviceFolderItemRef } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  deviceDisplayName,
  rememberDeviceName,
  resetDeviceNameCacheForTest,
} from './device-name-cache';
import {
  getNewFolderRequest,
  registerNewFolderRequest,
  resetNewFolderRequestForTest,
  subscribeNewFolderRequest,
} from './new-folder-request';
import type { NodeDeviceGroupEntry } from './node-device-group';
import { MissingDeviceCard, resolvePlacedDevice } from './placed-device';

installWindowStorage();

const NODE_ID = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function node(overrides: Partial<NodeDeviceGroupEntry> = {}): NodeDeviceGroupEntry {
  return {
    id: NODE_ID,
    runtimeNodeId: NODE_ID,
    name: 'attic',
    online: true,
    loggedIn: true,
    isSelf: false,
    isHub: false,
    version: null,
    inventory: null,
    ...overrides,
  };
}

const ITEM: DeviceFolderItemRef = { kind: 'device', nodeId: NODE_ID, deviceId: 'd1' };

function device(id: string): Device {
  return { id, name: `设备-${id}`, sortOrder: 0 } as unknown as Device;
}

describe('resolvePlacedDevice', () => {
  test('节点离线 / 未登录 / 不在列表里都渲染占位', () => {
    expect(resolvePlacedDevice(ITEM, null, [device('d1')])).toEqual({ kind: 'missing' });
    expect(resolvePlacedDevice(ITEM, node({ online: false }), [device('d1')])).toEqual({
      kind: 'missing',
    });
    expect(resolvePlacedDevice(ITEM, node({ loggedIn: false }), [device('d1')])).toEqual({
      kind: 'missing',
    });
  });

  test('设备列表还没回来是 loading，不是 missing', () => {
    expect(resolvePlacedDevice(ITEM, node(), undefined)).toEqual({ kind: 'loading' });
  });

  test('列表里没有这台设备（已删除）才算 missing', () => {
    expect(resolvePlacedDevice(ITEM, node(), [device('other')])).toEqual({ kind: 'missing' });
  });

  test('找到设备后带出设备本身', () => {
    const state = resolvePlacedDevice(ITEM, node(), [device('d1')]);
    expect(state.kind).toBe('ready');
    expect(state.kind === 'ready' && state.device.id).toBe('d1');
  });

  test('node 条目不该走到这里，一律 missing', () => {
    expect(
      resolvePlacedDevice({ kind: 'node', nodeId: NODE_ID, deviceId: null }, node(), [device('d1')])
    ).toEqual({ kind: 'missing' });
  });
});

describe('MissingDeviceCard', () => {
  test('占位带上节点名与设备 id，便于用户认出是哪一台', () => {
    const html = renderToStaticMarkup(<MissingDeviceCard item={ITEM} node={node()} />);
    expect(html).toContain(`data-testid="device-folder-missing-device:${NODE_ID}:d1"`);
    expect(html).toContain('devices.folders.missingDevice');
    expect(html).toContain('attic · d1');
  });

  test('连节点都不在列表里时退回 nodeId', () => {
    const html = renderToStaticMarkup(<MissingDeviceCard item={ITEM} node={null} />);
    expect(html).toContain(`${NODE_ID} · d1`);
  });
});

describe('device-name-cache', () => {
  beforeEach(() => resetDeviceNameCacheForTest());

  test('记过名字就用名字，没记过退回设备 id', () => {
    expect(deviceDisplayName('self', 'd1')).toBe('d1');
    rememberDeviceName('self', 'd1', '书房');
    expect(deviceDisplayName('self', 'd1')).toBe('书房');
    // 不同 node 的同名设备 id 互不干扰
    expect(deviceDisplayName(NODE_ID, 'd1')).toBe('d1');
  });

  test('空名字不写进缓存', () => {
    rememberDeviceName('self', 'd2', '');
    expect(deviceDisplayName('self', 'd2')).toBe('d2');
  });
});

describe('new-folder-request 注册表', () => {
  beforeEach(() => resetNewFolderRequestForTest());

  test('登记后顶栏拿得到回调，注销后回到空', () => {
    expect(getNewFolderRequest()).toBeNull();
    const request = () => undefined;
    const unregister = registerNewFolderRequest(request);
    expect(getNewFolderRequest()).toBe(request);
    unregister();
    expect(getNewFolderRequest()).toBeNull();
  });

  test('旧的注销函数不会摘掉后来者（页面重挂时的顺序问题）', () => {
    const first = () => undefined;
    const second = () => undefined;
    const unregisterFirst = registerNewFolderRequest(first);
    registerNewFolderRequest(second);
    unregisterFirst();
    expect(getNewFolderRequest()).toBe(second);
  });

  test('订阅者在登记 / 注销时各被通知一次', () => {
    let notified = 0;
    const unsubscribe = subscribeNewFolderRequest(() => {
      notified += 1;
    });
    const unregister = registerNewFolderRequest(() => undefined);
    unregister();
    unsubscribe();
    expect(notified).toBe(2);
  });
});
