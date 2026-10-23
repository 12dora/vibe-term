// 浏览器宿主的 navigate 必须把 opts.replace 透传给应用内导航：文件管理器打开预览靠它压栈。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setNavigateBridge } from './flow-bridges';
import { createBrowserHostServices } from './runtime';

let navCalls: Array<{ to: string; replace: boolean | undefined }> = [];

beforeEach(() => {
  navCalls = [];
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: () => true,
    location: { origin: 'https://vibeterm.test' },
  };
  setNavigateBridge((to, opts) => {
    navCalls.push({ to, replace: opts?.replace });
  });
});

afterEach(() => {
  setNavigateBridge(null);
  (globalThis as unknown as { window?: unknown }).window = undefined;
});

describe('createBrowserHostServices().navigate', () => {
  test('默认 replace（toast / 通知跳转不堆历史）', () => {
    createBrowserHostServices().navigate('/devices/d1');
    expect(navCalls).toEqual([{ to: '/devices/d1', replace: true }]);
  });

  test('replace:false 压栈，路径与 node 前缀不变', () => {
    const nodeId = 'cc'.repeat(16);
    const host = createBrowserHostServices({ nodeId, appPath: (p) => `/n/${nodeId}${p}` });
    host.navigate(`/n/${nodeId}/file/abc`, { replace: false });
    expect(navCalls).toEqual([{ to: `/n/${nodeId}/file/abc`, replace: false }]);
  });

  test('replace:true 显式替换', () => {
    createBrowserHostServices().navigate('/file/abc', { replace: true });
    expect(navCalls).toEqual([{ to: '/file/abc', replace: true }]);
  });
});
