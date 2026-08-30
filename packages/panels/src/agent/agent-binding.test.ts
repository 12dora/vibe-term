// AgentTab 按设备窄订阅 tmux 快照的语义验证。
// bun test 无 DOM，这里按 zustand 的默认 Object.is 判等语义直接判定：
// selector 结果引用不变即不触发订阅者重渲染。

import { describe, expect, test } from 'bun:test';

import type { Device, StateSnapshotPayload } from '@tmex/shared';

import {
  type SnapshotMap,
  bindingSource,
  deviceSnapshot,
  findPaneTitle,
  resolveBinding,
} from './agent-binding';

const devices: Device[] = [
  { id: 'd1', name: 'laptop' } as Device,
  { id: 'd2', name: 'desktop' } as Device,
];

function snapshot(paneId: string, paneTitle: string): StateSnapshotPayload {
  return {
    session: {
      windows: [
        {
          id: '@1',
          name: 'shell',
          customName: null,
          panes: [{ id: paneId, title: paneTitle, customName: null }],
        },
      ],
    },
  } as unknown as StateSnapshotPayload;
}

describe('deviceSnapshot 窄订阅', () => {
  test('无关设备的快照更新不改变目标设备的订阅结果', () => {
    const target = snapshot('%1', 'vim');
    const before: SnapshotMap = { d1: target, d2: snapshot('%2', 'htop') };
    // 另一台设备推快照/patch：整张 map 换引用
    const after: SnapshotMap = { ...before, d2: snapshot('%2', 'top') };

    expect(after).not.toBe(before);
    expect(deviceSnapshot(after, 'd1')).toBe(deviceSnapshot(before, 'd1'));
    expect(deviceSnapshot(after, 'd1')).toBe(target);
  });

  test('目标设备自身的快照更新会换引用', () => {
    const before: SnapshotMap = { d1: snapshot('%1', 'vim') };
    const after: SnapshotMap = { ...before, d1: snapshot('%1', 'less') };
    expect(deviceSnapshot(after, 'd1')).not.toBe(deviceSnapshot(before, 'd1'));
  });

  test('路由切设备后取到新设备的快照', () => {
    const snapshots: SnapshotMap = { d1: snapshot('%1', 'vim'), d2: snapshot('%2', 'htop') };
    expect(findPaneTitle(deviceSnapshot(snapshots, 'd1'), '%1')).toBe('vim');
    expect(findPaneTitle(deviceSnapshot(snapshots, 'd2'), '%2')).toBe('htop');
    // 切到 d2 后不再看得见 d1 的 pane
    expect(findPaneTitle(deviceSnapshot(snapshots, 'd2'), '%1')).toBeNull();
  });

  test('设备缺失或快照未到达时返回 undefined', () => {
    const snapshots: SnapshotMap = { d1: snapshot('%1', 'vim') };
    expect(deviceSnapshot(snapshots, null)).toBeUndefined();
    expect(deviceSnapshot(snapshots, 'missing')).toBeUndefined();
    expect(findPaneTitle(deviceSnapshot(snapshots, 'missing'), '%1')).toBeNull();
  });
});

describe('bindingSource', () => {
  test('有活动会话时取会话绑定的 pane', () => {
    const source = bindingSource(
      { deviceId: 'd1', paneId: '%1' },
      { deviceId: 'd2', paneId: '%2' }
    );
    expect(source).toEqual({ deviceId: 'd1', paneId: '%1' });
  });

  test('无会话时取草稿；两者皆无返回 null', () => {
    expect(bindingSource(undefined, { deviceId: 'd2', paneId: '%2' })).toEqual({
      deviceId: 'd2',
      paneId: '%2',
    });
    expect(bindingSource(undefined, null)).toBeNull();
  });
});

describe('resolveBinding 用绑定设备而非路由设备的快照', () => {
  test('路由切走后会话仍按自己设备的快照解析为有效', () => {
    const snapshots: SnapshotMap = { d1: snapshot('%1', 'vim'), d2: snapshot('%2', 'htop') };
    // 路由已在 d2，会话仍绑 d1/%1
    const source = bindingSource({ deviceId: 'd1', paneId: '%1' }, null) ?? {
      deviceId: null,
      paneId: null,
    };
    const binding = resolveBinding(source, deviceSnapshot(snapshots, source.deviceId), devices);
    expect(binding?.state).toBe('valid');
    expect(binding?.windowId).toBe('@1');
  });

  test('绑定设备的快照尚未到达时为 unknown，不因此判成失效', () => {
    const source = bindingSource({ deviceId: 'd1', paneId: '%1' }, null) ?? {
      deviceId: null,
      paneId: null,
    };
    const binding = resolveBinding(source, deviceSnapshot({}, source.deviceId), devices);
    expect(binding?.state).toBe('unknown');
  });
});
