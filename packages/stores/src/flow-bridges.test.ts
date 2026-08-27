import { beforeEach, describe, expect, test } from 'bun:test';
import {
  bridgeIsMobile,
  bridgeNavigate,
  resetFlowBridgesForTest,
  setNavigateBridge,
  setSidebarBridge,
} from './flow-bridges';

beforeEach(() => {
  resetFlowBridgesForTest();
});

describe('flow bridges 栈式注册', () => {
  test('最后注册的生效', () => {
    const calls: string[] = [];
    setNavigateBridge((to) => calls.push(`a:${to}`));
    setNavigateBridge((to) => calls.push(`b:${to}`));

    bridgeNavigate('/devices');
    expect(calls).toEqual(['b:/devices']);
  });

  test('旧边界卸载不会抹掉新边界的注册（node 切换时新旧短暂并存）', () => {
    const calls: string[] = [];
    const unregisterOld = setNavigateBridge((to) => calls.push(`old:${to}`));
    setNavigateBridge((to) => calls.push(`new:${to}`));

    unregisterOld();
    bridgeNavigate('/devices');
    expect(calls).toEqual(['new:/devices']);
  });

  test('注销后回落到上一个注册', () => {
    const calls: string[] = [];
    setNavigateBridge((to) => calls.push(`a:${to}`));
    const unregisterB = setNavigateBridge((to) => calls.push(`b:${to}`));

    unregisterB();
    bridgeNavigate('/devices');
    expect(calls).toEqual(['a:/devices']);
  });

  test('全部注销后导航是 no-op', () => {
    const unregister = setNavigateBridge(() => {
      throw new Error('should not be called');
    });
    unregister();
    expect(() => bridgeNavigate('/devices')).not.toThrow();
  });

  test('sidebar 桥同样栈式生效', () => {
    setSidebarBridge({ isMobile: false, setOpenMobile: () => {} });
    const unregister = setSidebarBridge({ isMobile: true, setOpenMobile: () => {} });
    expect(bridgeIsMobile()).toBe(true);
    unregister();
    expect(bridgeIsMobile()).toBe(false);
  });
});
