// 冷启动预算：弱网 / 省流量不预热，终端路由推到首个终端内容绘制之后。
// 回归了就等于首帧之后立刻又去抢 1.2 MB 带宽，终端首帧在 2 Mbps 下被推后好几秒。

import { describe, expect, test } from 'bun:test';
import {
  FIRST_PAINT_FALLBACK_MS,
  allowsStartupPreload,
  isDeviceConsolePath,
  startupPreloadGate,
} from './chunk-preload';

describe('allowsStartupPreload', () => {
  test('拿不到 navigator.connection 时保持原行为（桌面 Safari / Firefox）', () => {
    expect(allowsStartupPreload(null)).toBe(true);
  });

  test('saveData 是用户明示意愿，一票否决', () => {
    expect(allowsStartupPreload({ saveData: true, effectiveType: '4g' })).toBe(false);
  });

  test('只放行 4g；2g / 3g / slow-2g 一律不预热', () => {
    expect(allowsStartupPreload({ effectiveType: '4g' })).toBe(true);
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect({ effectiveType, allowed: allowsStartupPreload({ effectiveType }) }).toEqual({
        effectiveType,
        allowed: false,
      });
    }
  });

  test('有 connection 但没有 effectiveType：信息不足时不擅自降级', () => {
    expect(allowsStartupPreload({})).toBe(true);
    expect(allowsStartupPreload({ saveData: false })).toBe(true);
  });
});

describe('isDeviceConsolePath', () => {
  test('识别终端路由（含 /n/<nodeId> 前缀与 window/pane 段）', () => {
    expect(isDeviceConsolePath('/devices/abc')).toBe(true);
    expect(isDeviceConsolePath('/devices/abc/windows/1/panes/%251')).toBe(true);
    expect(isDeviceConsolePath('/n/node-1/devices/abc')).toBe(true);
  });

  test('设备列表 / 设置 / 登录不是终端路由', () => {
    expect(isDeviceConsolePath('/devices')).toBe(false);
    expect(isDeviceConsolePath('/settings')).toBe(false);
    expect(isDeviceConsolePath('/login')).toBe(false);
    expect(isDeviceConsolePath('/n/node-1/devices')).toBe(false);
  });
});

describe('startupPreloadGate', () => {
  const never = () => new Promise<void>(() => {});

  test('弱网返回 null（本次启动完全不预热）', () => {
    expect(
      startupPreloadGate({
        pathname: '/devices',
        connection: { effectiveType: '3g' },
        whenFirstTerminalPaint: never,
      })
    ).toBeNull();
  });

  test('非终端路由立即放行', async () => {
    const gate = startupPreloadGate({
      pathname: '/devices',
      connection: { effectiveType: '4g' },
      whenFirstTerminalPaint: never,
    });
    expect(gate).not.toBeNull();
    await expect(gate as Promise<void>).resolves.toBeUndefined();
  });

  test('终端路由等首帧信号', async () => {
    let paint: (() => void) | null = null;
    const painted = new Promise<void>((resolve) => {
      paint = resolve;
    });
    let resolved = false;
    const gate = startupPreloadGate({
      pathname: '/devices/abc/windows/1/panes/%251',
      connection: null,
      whenFirstTerminalPaint: () => painted,
      setTimeout: () => 0,
    });
    void (gate as Promise<void>).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    (paint as unknown as () => void)();
    await gate;
    expect(resolved).toBe(true);
  });

  test('终端始终不出内容时按兜底期限放行', async () => {
    const timers: number[] = [];
    const gate = startupPreloadGate({
      pathname: '/devices/abc',
      connection: null,
      whenFirstTerminalPaint: never,
      setTimeout: (callback, ms) => {
        timers.push(ms);
        callback();
        return 0;
      },
    });
    await expect(gate as Promise<void>).resolves.toBeUndefined();
    expect(timers).toEqual([FIRST_PAINT_FALLBACK_MS]);
  });
});
