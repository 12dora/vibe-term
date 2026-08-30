import { describe, expect, test } from 'bun:test';
import { matchPath } from 'react-router';

import { createBrowserHostServices, hostAppPath } from '@tmex/stores';

import { AGENT_PANE_ROUTE_PATH } from './use-agent-tab-state';

const NODE_A = 'a'.repeat(32);

// useMatch 先对 pathname 整体解码再匹配，测试里用同样的形状喂 matchPath
describe('pane route pattern', () => {
  test('matches the plain route for the self host', () => {
    const host = createBrowserHostServices();
    const pattern = hostAppPath(host, AGENT_PANE_ROUTE_PATH);
    const match = matchPath(pattern, '/devices/d1/windows/@1/panes/%1');
    expect(match?.params.deviceId).toBe('d1');
    expect(match?.params.paneId).toBe('%1');
  });

  test('matches the /n/:nodeId route for a remote host', () => {
    const host = createBrowserHostServices({
      nodeId: NODE_A,
      appPath: (path) => `/n/${NODE_A}${path}`,
    });
    const pattern = hostAppPath(host, AGENT_PANE_ROUTE_PATH);
    expect(pattern).toBe(`/n/${NODE_A}/devices/:deviceId/windows/:windowId/panes/:paneId`);

    const match = matchPath(pattern, `/n/${NODE_A}/devices/d1/windows/@1/panes/%1`);
    expect(match?.params.deviceId).toBe('d1');
    expect(match?.params.windowId).toBe('@1');
    expect(match?.params.paneId).toBe('%1');

    // 没有前缀的旧路由不应命中远端 pattern
    expect(matchPath(pattern, '/devices/d1/windows/@1/panes/%1')).toBeNull();
  });

  test('the plain pattern does not match a /n/:nodeId route', () => {
    const pattern = hostAppPath(createBrowserHostServices(), AGENT_PANE_ROUTE_PATH);
    expect(matchPath(pattern, `/n/${NODE_A}/devices/d1/windows/@1/panes/%1`)).toBeNull();
  });
});
