import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@tmex/shared';
import type { HostServices } from '@tmex/stores';
import {
  DEVICE_ROUTE_PATH,
  PANE_ROUTE_PATH,
  PENDING_NAVIGATION_TTL_MS,
  buildPaneRoutePath,
  deviceTreeRoutePatterns,
  parseDeviceTreeSelection,
  pickActivePane,
  resolvePendingNavigation,
} from './device-tree-navigation';

const identityHost = {} as HostServices;
const prefixedHost = { appPath: (path: string) => `/app${path}` } as HostServices;

const patterns = { panePath: PANE_ROUTE_PATH, devicePath: DEVICE_ROUTE_PATH };

describe('parseDeviceTreeSelection', () => {
  test('reads device/window/pane from a full pane route', () => {
    expect(parseDeviceTreeSelection('/devices/dev-1/windows/@3/panes/%254', patterns)).toEqual({
      selectedDeviceId: 'dev-1',
      selectedWindowId: '@3',
      selectedPaneId: '%4',
    });
  });

  test('keeps tmux pane ids that look like percent escapes intact', () => {
    // "%2512" 解码一次得到 "%12"；再解码会误还原成不存在的 pane id
    expect(
      parseDeviceTreeSelection('/devices/dev-1/windows/@0/panes/%252512', patterns).selectedPaneId
    ).toBe('%2512');
  });

  test('falls back to the device-only route', () => {
    expect(parseDeviceTreeSelection('/devices/dev-9/settings', patterns)).toEqual({
      selectedDeviceId: 'dev-9',
      selectedWindowId: undefined,
      selectedPaneId: undefined,
    });
  });

  test('returns an empty selection outside the device tree', () => {
    expect(parseDeviceTreeSelection('/settings/llm', patterns)).toEqual({
      selectedDeviceId: undefined,
      selectedWindowId: undefined,
      selectedPaneId: undefined,
    });
  });

  test('honours the host route prefix', () => {
    const hostPatterns = deviceTreeRoutePatterns(prefixedHost);
    expect(hostPatterns).toEqual({
      panePath: '/app/devices/:deviceId/windows/:windowId/panes/:paneId',
      devicePath: '/app/devices/:deviceId',
    });
    expect(parseDeviceTreeSelection('/app/devices/dev-1', hostPatterns).selectedDeviceId).toBe(
      'dev-1'
    );
    expect(
      parseDeviceTreeSelection('/devices/dev-1', hostPatterns).selectedDeviceId
    ).toBeUndefined();
  });
});

describe('buildPaneRoutePath', () => {
  test('percent-encodes the pane id', () => {
    expect(buildPaneRoutePath(identityHost, 'dev-1', '@3', '%4')).toBe(
      '/devices/dev-1/windows/@3/panes/%254'
    );
  });

  test('round-trips through parseDeviceTreeSelection under a host prefix', () => {
    const path = buildPaneRoutePath(prefixedHost, 'dev-1', '@3', '%12');
    expect(path).toBe('/app/devices/dev-1/windows/@3/panes/%2512');
    expect(parseDeviceTreeSelection(path, deviceTreeRoutePatterns(prefixedHost))).toEqual({
      selectedDeviceId: 'dev-1',
      selectedWindowId: '@3',
      selectedPaneId: '%12',
    });
  });
});

describe('pickActivePane', () => {
  test('prefers the active pane', () => {
    expect(
      pickActivePane([
        { id: '%1', active: false },
        { id: '%2', active: true },
      ])
    ).toEqual({ id: '%2', active: true });
  });

  test('falls back to the first pane', () => {
    expect(
      pickActivePane([
        { id: '%1', active: false },
        { id: '%2', active: false },
      ])
    ).toEqual({ id: '%1', active: false });
  });

  test('returns undefined for empty or missing panes', () => {
    expect(pickActivePane([])).toBeUndefined();
    expect(pickActivePane(undefined)).toBeUndefined();
  });
});

describe('resolvePendingNavigation', () => {
  const windows = [
    { id: '@1', name: 'one', index: 0, active: false, panes: [] },
    {
      id: '@2',
      name: 'two',
      index: 1,
      active: true,
      panes: [
        { id: '%1', windowId: '@2', index: 0, active: false, width: 80, height: 24 },
        { id: '%2', windowId: '@2', index: 1, active: true, width: 80, height: 24 },
      ],
    },
  ] satisfies TmuxWindow[];

  const lookup = (deviceId: string) => (deviceId === 'dev-1' ? windows : undefined);

  test('is idle without a pending navigation', () => {
    expect(resolvePendingNavigation(null, lookup, 1_000)).toEqual({ status: 'idle' });
  });

  test('expires a stale pending navigation', () => {
    expect(
      resolvePendingNavigation(
        { deviceId: 'dev-1', windowId: '@2', at: 0 },
        lookup,
        PENDING_NAVIGATION_TTL_MS + 1
      )
    ).toEqual({ status: 'expired' });
  });

  test('keeps waiting while the device snapshot has not arrived', () => {
    expect(
      resolvePendingNavigation({ deviceId: 'dev-2', windowId: '@2', at: 0 }, lookup, 10)
    ).toEqual({ status: 'waiting' });
  });

  test('keeps waiting while the target window has no panes', () => {
    expect(
      resolvePendingNavigation({ deviceId: 'dev-1', windowId: '@1', at: 0 }, lookup, 10)
    ).toEqual({ status: 'waiting' });
    expect(
      resolvePendingNavigation({ deviceId: 'dev-1', windowId: '@404', at: 0 }, lookup, 10)
    ).toEqual({ status: 'waiting' });
  });

  test('resolves to the active pane once panes are available', () => {
    expect(
      resolvePendingNavigation({ deviceId: 'dev-1', windowId: '@2', at: 0 }, lookup, 10)
    ).toEqual({ status: 'ready', deviceId: 'dev-1', windowId: '@2', paneId: '%2' });
  });

  test('resolves exactly at the ttl boundary', () => {
    expect(
      resolvePendingNavigation(
        { deviceId: 'dev-1', windowId: '@2', at: 0 },
        lookup,
        PENDING_NAVIGATION_TTL_MS
      ).status
    ).toBe('ready');
  });
});
