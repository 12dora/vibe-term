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

export function parseDeviceTreeSelection(
  pathname: string,
  patterns: DeviceTreeRoutePatterns
): DeviceTreeSelection {
  const paneMatch = matchPath(patterns.panePath, pathname);
  const deviceMatch = matchPath({ path: patterns.devicePath, end: false }, pathname);
  return {
    selectedDeviceId: paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId,
    selectedWindowId: paneMatch?.params.windowId,
    // matchPath 接收的是 location.pathname，其中 paneId 仍保留 URL 编码；只在这里解码一次，
    // 再交给 tmux URL 工具保持与 useParams 路径一致。
    selectedPaneId: decodePaneIdFromUrlParam(
      paneMatch?.params.paneId ? decodeURIComponent(paneMatch.params.paneId) : undefined
    ),
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

  const pendingNavigationRef = useRef<PendingNavigation | null>(null);

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
      pendingNavigationRef.current = null;

      dispatchUserInitiatedSelection({ nodeId, deviceId, windowId, paneId });
      handleNavigate(buildPaneRoutePath(host, deviceId, windowId, paneId), {
        keepSidebarOpen: options?.keepSidebarOpen,
      });
    },
    [handleNavigate, host, nodeId]
  );

  useEffect(() => {
    const outcome = resolvePendingNavigation(
      pendingNavigationRef.current,
      (deviceId) => snapshots[deviceId]?.session?.windows,
      Date.now()
    );
    if (outcome.status === 'expired') {
      pendingNavigationRef.current = null;
      return;
    }
    if (outcome.status !== 'ready') return;
    pendingNavigationRef.current = null;
    navigateToPane(outcome.deviceId, outcome.windowId, outcome.paneId);
  }, [snapshots, navigateToPane]);

  const navigateToWindow = useCallback(
    (deviceId: string, windowId: string, panes: TmuxPane[]) => {
      selectWindow(deviceId, windowId);

      const activePane = pickActivePane(panes);
      if (activePane) {
        navigateToPane(deviceId, windowId, activePane.id);
        pendingNavigationRef.current = null;
      } else {
        pendingNavigationRef.current = { deviceId, windowId, at: Date.now() };
      }
    },
    [navigateToPane, selectWindow]
  );

  const nav = useMemo<DeviceTreeNavigation>(() => ({ navigateToPane }), [navigateToPane]);

  return { handleNavigate, navigateToPane, navigateToWindow, nav };
}
