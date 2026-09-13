import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nodeAppPath } from '@vibeterm/api-client';
import type { AppRuntime } from '@vibeterm/stores';
import { createBrowserHostServices, setNavigateBridge, setSidebarBridge } from '@vibeterm/stores';
import { navigateToWatchUrl } from './watch-events-init';

const NODE_B = 'bb'.repeat(16);

let dispatched: CustomEvent[] = [];
let navCalls: Array<{ to: string; opts?: { replace?: boolean } }> = [];

beforeEach(() => {
  dispatched = [];
  navCalls = [];
  (
    globalThis as unknown as {
      window: { dispatchEvent: (e: Event) => boolean; location: { origin: string } };
    }
  ).window = {
    dispatchEvent: (e: Event) => {
      dispatched.push(e as CustomEvent);
      return true;
    },
    location: { origin: 'https://vibeterm.test' },
  };
  setNavigateBridge((to, opts) => {
    navCalls.push({ to, opts });
  });
  setSidebarBridge({ isMobile: false, setOpenMobile: () => {} });
});

afterEach(() => {
  setNavigateBridge(null);
  setSidebarBridge(null);
});

function watchRuntime(): AppRuntime {
  return {
    nodeId: NODE_B,
    host: createBrowserHostServices({
      nodeId: NODE_B,
      appPath: (path) => nodeAppPath(NODE_B, path),
    }),
  } as AppRuntime;
}

describe('navigateToWatchUrl', () => {
  test('tmux pane id %2 / 坏转义 %zz 不抛；detail 带 nodeId，导航目标带 /n/<id>', () => {
    const runtime = watchRuntime();

    expect(() => navigateToWatchUrl(runtime, '/devices/d1/windows/@1/panes/%2')).not.toThrow();
    expect(dispatched[0]?.detail).toMatchObject({
      nodeId: NODE_B,
      deviceId: 'd1',
      windowId: '@1',
      paneId: '%2',
    });
    expect(navCalls[0]?.to).toBe(`/n/${NODE_B}/devices/d1/windows/@1/panes/%2`);

    expect(() => navigateToWatchUrl(runtime, '/devices/d1/windows/@1/panes/%zz')).not.toThrow();
    expect(dispatched.at(-1)?.detail).toMatchObject({
      nodeId: NODE_B,
      paneId: '%zz',
    });
    expect(navCalls.at(-1)?.to).toBe(`/n/${NODE_B}/devices/d1/windows/@1/panes/%zz`);
  });

  test('%252 解码为原始 pane id %2，且 CustomEvent 带来源 nodeId', () => {
    const runtime = watchRuntime();
    expect(() => navigateToWatchUrl(runtime, '/devices/d1/windows/@1/panes/%252')).not.toThrow();
    expect(dispatched[0]?.detail).toEqual({
      nodeId: NODE_B,
      deviceId: 'd1',
      windowId: '@1',
      paneId: '%2',
    });
    expect(navCalls[0]?.to).toBe(`/n/${NODE_B}/devices/d1/windows/@1/panes/%252`);
  });
});
