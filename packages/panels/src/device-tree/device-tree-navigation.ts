import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import type { HostServices } from '@tmex/stores';
import {
  decodePaneIdFromUrlParam,
  dispatchUserInitiatedSelection,
  encodePaneIdForUrl,
  hostAppPath,
} from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import type { DeviceTreeNavigation } from './agent-adapter';

export const PANE_ROUTE_PATH = '/devices/:deviceId/windows/:windowId/panes/:paneId';
export const DEVICE_ROUTE_PATH = '/devices/:deviceId';

/** 跨设备切换时 panes 尚未到达，pending 导航的有效期 */
export const PENDING_NAVIGATION_TTL_MS = 5000;

export interface DeviceTreeSelection {
  selectedDeviceId?: string;
  selectedWindowId?: string;
  selectedPaneId?: string;
}

export interface DeviceTreeRoutePatterns {
  panePath: string;
  devicePath: string;
}

export interface PendingNavigation {
  deviceId: string;
  windowId: string;
  at: number;
}

export type PendingNavigationOutcome =
  | { status: 'idle' }
  | { status: 'expired' }
  | { status: 'waiting' }
  | { status: 'ready'; deviceId: string; windowId: string; paneId: string };

export function deviceTreeRoutePatterns(host: HostServices): DeviceTreeRoutePatterns {
  return {
    panePath: hostAppPath(host, PANE_ROUTE_PATH),
    devicePath: hostAppPath(host, DEVICE_ROUTE_PATH),
  };
}

export function buildPaneRoutePath(
  host: HostServices,
  deviceId: string,
  windowId: string,
  paneId: string
): string {
  return hostAppPath(
    host,
    `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`
  );
}

/**
 * matchPath 接收的是 location.pathname，其中 paneId 仍保留 URL 编码；只在这里解码一次，
 * 再交给 tmux URL 工具保持与 useParams 路径一致。
 * 手工敲坏的 `%` 序列（如 `/panes/%zz`）会让 decodeURIComponent 抛 URIError 并整棵侧边栏白屏，
 * 这里降级成原样返回，让选择落空而不是崩溃。
 */
export function safeDecodePaneParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseDeviceTreeSelection(
  pathname: string,
  patterns: DeviceTreeRoutePatterns
): DeviceTreeSelection {
  const paneMatch = matchPath(patterns.panePath, pathname);
  const deviceMatch = matchPath({ path: patterns.devicePath, end: false }, pathname);
  return {
    selectedDeviceId: paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId,
    selectedWindowId: paneMatch?.params.windowId,
    selectedPaneId: decodePaneIdFromUrlParam(safeDecodePaneParam(paneMatch?.params.paneId)),
  };
}

export function pickActivePane<T extends { active?: boolean }>(
  panes: readonly T[] | undefined
): T | undefined {
  if (!panes?.length) return undefined;
  return panes.find((pane) => pane.active) ?? panes[0];
}

export function resolvePendingNavigation(
  pending: PendingNavigation | null,
  lookupWindows: (deviceId: string) => readonly TmuxWindow[] | undefined,
  now: number
): PendingNavigationOutcome {
  if (!pending) return { status: 'idle' };
  // 过期的 pending 导航会抢走用户后续的手动选择，直接丢弃
  if (now - pending.at > PENDING_NAVIGATION_TTL_MS) return { status: 'expired' };

  const windows = lookupWindows(pending.deviceId);
  if (!windows) return { status: 'waiting' };

  const targetWindow = windows.find((w) => w.id === pending.windowId);
  const activePane = pickActivePane(targetWindow?.panes);
  if (!activePane) return { status: 'waiting' };

  return {
    status: 'ready',
    deviceId: pending.deviceId,
    windowId: pending.windowId,
    paneId: activePane.id,
  };
}

/**
 * pending 导航只在用户仍停留在目标设备的路由上时有效。
 * 否则用户点完无 pane 的窗口后立刻走普通 NavLink 去别处（如 /devices），
 * 5s 内到货的快照仍会把他拽回那个 pane。
 */
export function pendingNavigationSurvivesPath(
  pending: PendingNavigation | null,
  pathname: string,
  patterns: DeviceTreeRoutePatterns
): boolean {
  if (!pending) return false;
  return parseDeviceTreeSelection(pathname, patterns).selectedDeviceId === pending.deviceId;
}

export interface PendingNavigationTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface PendingNavigationSlotOptions {
  ttlMs?: number;
  timers?: PendingNavigationTimers;
}

/**
 * pending 导航的单槽存储：写入即挂 TTL 定时器，到期自行清空。
 * 只靠 snapshots 变化去判过期的话，目标设备一直不推快照时这条 pending 会无限存活，
 * 之后突然到货就会抢走用户早已改过的选择。
 */
export interface PendingNavigationSlot {
  get(): PendingNavigation | null;
  set(pending: PendingNavigation): void;
  clear(): void;
  dispose(): void;
}

const defaultTimers: PendingNavigationTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createPendingNavigationSlot(
  options: PendingNavigationSlotOptions = {}
): PendingNavigationSlot {
  const ttlMs = options.ttlMs ?? PENDING_NAVIGATION_TTL_MS;
  const timers = options.timers ?? defaultTimers;

  let pending: PendingNavigation | null = null;
  let handle: unknown = null;

  const cancelTimer = () => {
    if (handle === null) return;
    timers.clearTimer(handle);
    handle = null;
  };

  return {
    get: () => pending,
    set: (next) => {
      cancelTimer();
      pending = next;
      handle = timers.setTimer(() => {
        handle = null;
        pending = null;
      }, ttlMs);
    },
    clear: () => {
      cancelTimer();
      pending = null;
    },
    dispose: () => {
      cancelTimer();
      pending = null;
    },
  };
}

function usePendingNavigationSlot(): PendingNavigationSlot {
  const slotRef = useRef<PendingNavigationSlot | null>(null);
  if (slotRef.current === null) slotRef.current = createPendingNavigationSlot();
  const slot = slotRef.current;

  useEffect(() => () => slot.dispose(), [slot]);

  return slot;
}

export function useDeviceTreeSelection(): DeviceTreeSelection {
  const { host } = useRuntime();
  const { pathname } = useLocation();
  return useMemo(
    () => parseDeviceTreeSelection(pathname, deviceTreeRoutePatterns(host)),
    [host, pathname]
  );
}

export interface NavigateOptions {
  replace?: boolean;
  keepSidebarOpen?: boolean;
}

export interface DeviceTreeNavigationApi {
  handleNavigate: (to: string, options?: NavigateOptions) => void;
  navigateToPane: DeviceTreeNavigation['navigateToPane'];
  navigateToWindow: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  nav: DeviceTreeNavigation;
}

export function useDeviceTreeNavigationApi(): DeviceTreeNavigationApi {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { host, nodeId } = useRuntime();
  const selectWindow = useTmuxStore((state) => state.selectWindow);
  const snapshots = useTmuxStore((state) => state.snapshots);
  const { pathname } = useLocation();
  const patterns = useMemo(() => deviceTreeRoutePatterns(host), [host]);

  const pendingNavigation = usePendingNavigationSlot();

  // 路由离开目标设备即作废 pending：普通 NavLink 跳转不会经过 navigateToPane，
  // 否则 TTL 内到货的快照会把用户从新页面拽回旧 pane
  useEffect(() => {
    const pending = pendingNavigation.get();
    if (!pending) return;
    if (pendingNavigationSurvivesPath(pending, pathname, patterns)) return;
    pendingNavigation.clear();
  }, [pathname, patterns, pendingNavigation]);

  const handleNavigate = useCallback(
    (to: string, options?: NavigateOptions) => {
      navigate(to, { replace: options?.replace ?? true });
      if (isMobile && !options?.keepSidebarOpen) setOpenMobile(false);
    },
    [navigate, isMobile, setOpenMobile]
  );

  const navigateToPane = useCallback(
    (
      deviceId: string,
      windowId: string,
      paneId: string,
      options?: { keepSidebarOpen?: boolean }
    ) => {
      pendingNavigation.clear();

      dispatchUserInitiatedSelection({ nodeId, deviceId, windowId, paneId });
      handleNavigate(buildPaneRoutePath(host, deviceId, windowId, paneId), {
        keepSidebarOpen: options?.keepSidebarOpen,
      });
    },
    [handleNavigate, host, nodeId, pendingNavigation]
  );

  useEffect(() => {
    const outcome = resolvePendingNavigation(
      pendingNavigation.get(),
      (deviceId) => snapshots[deviceId]?.session?.windows,
      Date.now()
    );
    if (outcome.status === 'expired') {
      pendingNavigation.clear();
      return;
    }
    if (outcome.status !== 'ready') return;
    pendingNavigation.clear();
    navigateToPane(outcome.deviceId, outcome.windowId, outcome.paneId);
  }, [snapshots, navigateToPane, pendingNavigation]);

  const navigateToWindow = useCallback(
    (deviceId: string, windowId: string, panes: TmuxPane[]) => {
      selectWindow(deviceId, windowId);

      const activePane = pickActivePane(panes);
      if (activePane) {
        navigateToPane(deviceId, windowId, activePane.id);
        pendingNavigation.clear();
      } else {
        pendingNavigation.set({ deviceId, windowId, at: Date.now() });
      }
    },
    [navigateToPane, selectWindow, pendingNavigation]
  );

  const nav = useMemo<DeviceTreeNavigation>(() => ({ navigateToPane }), [navigateToPane]);

  return { handleNavigate, navigateToPane, navigateToWindow, nav };
}
