import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@tmex/shared';
import type { HostServices } from '@tmex/stores';
import {
  DEVICE_ROUTE_PATH,
  PANE_ROUTE_PATH,
  PENDING_NAVIGATION_TTL_MS,
  buildPaneRoutePath,
  createPendingNavigationSlot,
  deviceTreeRoutePatterns,
  parseDeviceTreeSelection,
  pickActivePane,
  resolvePendingNavigation,
  safeDecodePaneParam,
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

  test('survives a malformed percent escape in the pane segment', () => {
    expect(parseDeviceTreeSelection('/devices/dev-1/windows/@3/panes/%zz', patterns)).toEqual({
      selectedDeviceId: 'dev-1',
      selectedWindowId: '@3',
      selectedPaneId: '%zz',
    });
    expect(
      parseDeviceTreeSelection('/devices/dev-1/windows/@3/panes/%E0%A4%A', patterns).selectedPaneId
    ).toBe('%E0%A4%A');
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

describe('safeDecodePaneParam', () => {
  test('decodes a well-formed escape once', () => {
    expect(safeDecodePaneParam('%254')).toBe('%4');
  });

  test('returns the raw value for malformed escapes instead of throwing', () => {
    expect(safeDecodePaneParam('%zz')).toBe('%zz');
    expect(safeDecodePaneParam('%')).toBe('%');
    expect(safeDecodePaneParam('%E0%A4%A')).toBe('%E0%A4%A');
  });

  test('normalises missing and empty params to an empty selection', () => {
    expect(safeDecodePaneParam(undefined)).toBeUndefined();
    expect(safeDecodePaneParam('')).toBeUndefined();
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

describe('createPendingNavigationSlot', () => {
  function fakeTimers() {
    const scheduled = new Map<number, { fn: () => void; ms: number }>();
    let nextHandle = 1;
    return {
      scheduled,
      timers: {
        setTimer: (fn: () => void, ms: number) => {
          const handle = nextHandle++;
          scheduled.set(handle, { fn, ms });
          return handle;
        },
        clearTimer: (handle: unknown) => {
          scheduled.delete(handle as number);
        },
      },
      fire: (handle: number) => {
        const entry = scheduled.get(handle);
        scheduled.delete(handle);
        entry?.fn();
      },
    };
  }

  const pending = { deviceId: 'dev-1', windowId: '@2', at: 0 };

  test('starts empty', () => {
    expect(createPendingNavigationSlot().get()).toBeNull();
  });

  test('arms a ttl timer on write and expires without any snapshot change', () => {
    const { timers, scheduled, fire } = fakeTimers();
    const slot = createPendingNavigationSlot({ timers });

    slot.set(pending);
    expect(slot.get()).toEqual(pending);
    expect([...scheduled.values()][0]?.ms).toBe(PENDING_NAVIGATION_TTL_MS);

    fire(1);
    expect(slot.get()).toBeNull();
  });

  test('honours a custom ttl', () => {
    const { timers, scheduled } = fakeTimers();
    createPendingNavigationSlot({ timers, ttlMs: 42 }).set(pending);
    expect([...scheduled.values()][0]?.ms).toBe(42);
  });

  test('clear drops both the value and the timer', () => {
    const { timers, scheduled } = fakeTimers();
    const slot = createPendingNavigationSlot({ timers });

    slot.set(pending);
    slot.clear();
    expect(slot.get()).toBeNull();
    expect(scheduled.size).toBe(0);
  });

  test('re-writing replaces the previous timer so the ttl restarts', () => {
    const { timers, scheduled, fire } = fakeTimers();
    const slot = createPendingNavigationSlot({ timers });

    slot.set(pending);
    const next = { deviceId: 'dev-2', windowId: '@5', at: 1 };
    slot.set(next);
    expect(scheduled.size).toBe(1);

    fire(1);
    expect(slot.get()).toEqual(next);
    fire(2);
    expect(slot.get()).toBeNull();
  });

  test('dispose clears the timer so an unmounted tree never fires', () => {
    const { timers, scheduled } = fakeTimers();
    const slot = createPendingNavigationSlot({ timers });

    slot.set(pending);
    slot.dispose();
    expect(scheduled.size).toBe(0);
    expect(slot.get()).toBeNull();
  });
});
