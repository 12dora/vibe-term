// tmux store 与拓扑缓存的接线端到端：实时快照落地 → 写通 localStorage → 下一个 runtime
// 在建店时 hydrate 出占位（正是 PWA 冷启动那条路径）。

import { describe, expect, test } from 'bun:test';
import { createAppRuntime } from './app-runtime';
import { installWindowStorage } from './test-utils';
import { readTmuxTopologyCache, tmuxTopologyCacheKey } from './tmux-topology-cache';

installWindowStorage();

const SNAPSHOT = {
  deviceId: 'dev-1',
  session: {
    id: '$0',
    name: 'main',
    windows: [
      {
        id: '@1',
        name: 'zsh',
        index: 0,
        active: true,
        panes: [{ id: '%1', windowId: '@1', index: 0, active: true, width: 80, height: 24 }],
      },
    ],
  },
};

describe('拓扑缓存与 tmux store 的接线', () => {
  test('快照落地即写通，重建 runtime 时 hydrate 成占位', () => {
    const storagePrefix = 'topology-hydration-1:';
    const first = createAppRuntime({ nodeId: 'self', storagePrefix });
    first.stores.tmux.setState({ snapshots: { 'dev-1': SNAPSHOT } });

    expect(localStorage.getItem(tmuxTopologyCacheKey(storagePrefix))).not.toBeNull();
    expect(readTmuxTopologyCache(storagePrefix)['dev-1']?.windows).toHaveLength(1);
    first.dispose();

    const second = createAppRuntime({ nodeId: 'self', storagePrefix });
    const placeholders = second.stores.tmux.getState().topologyPlaceholders;
    expect(placeholders['dev-1']?.windows[0]?.id).toBe('@1');
    // 占位不得混进 snapshots：选择恢复与路由对账只认实时数据
    expect(second.stores.tmux.getState().snapshots['dev-1']).toBeUndefined();
    second.dispose();
  });

  test('runtime 卸载后不再写盘', () => {
    const storagePrefix = 'topology-hydration-2:';
    const runtime = createAppRuntime({ nodeId: 'self', storagePrefix });
    runtime.dispose();
    runtime.stores.tmux.setState({ snapshots: { 'dev-1': SNAPSHOT } });

    expect(localStorage.getItem(tmuxTopologyCacheKey(storagePrefix))).toBeNull();
  });
});
