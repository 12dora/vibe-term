import { useQuery } from '@tanstack/react-query';
import { fetchDevices } from '@tmex/api-client';
import { hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { matchPath, useLocation } from 'react-router';

interface GlobalDeviceContextValue {
  ensureDeviceSubscribed: (deviceId: string) => void;
}

const GlobalDeviceContext = createContext<GlobalDeviceContextValue | null>(null);

/** 本 runtime 的设备路由 pattern（多 node 下带 `/n/:nodeId` 前缀）。 */
export function deviceRoutePattern(appPath: (path: string) => string): string {
  return appPath('/devices/:deviceId');
}

/** 从 pathname 取本 runtime 路由形状下的 deviceId；不属于本 node 的路径返回 undefined。 */
export function routeDeviceId(
  pathname: string,
  appPath: (path: string) => string
): string | undefined {
  const match = matchPath({ path: deviceRoutePattern(appPath), end: false }, pathname);
  return match?.params.deviceId;
}

export function shouldEnsureRouteDeviceSubscription(
  deviceId: string | undefined,
  devicesData: { devices: Array<{ id: string }> } | undefined
): deviceId is string {
  return Boolean(
    deviceId && (!devicesData || devicesData.devices.some((device) => device.id === deviceId))
  );
}

export function useGlobalDevice(): GlobalDeviceContextValue {
  const ctx = useContext(GlobalDeviceContext);
  if (!ctx) {
    throw new Error('useGlobalDevice must be used within GlobalDeviceProvider');
  }
  return ctx;
}

interface GlobalDeviceProviderProps {
  children: React.ReactNode;
}

export function GlobalDeviceProvider({ children }: GlobalDeviceProviderProps) {
  const location = useLocation();
  const runtime = useRuntime();
  const connectTmuxDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectTmuxDevice = useTmuxStore((state) => state.disconnectDevice);
  const connectedDevices = useTmuxStore((state) => state.connectedDevices);

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const ensureDeviceSubscribed = useCallback(
    (deviceId: string) => {
      if (deviceId && !connectedDevices.has(deviceId)) {
        connectTmuxDevice(deviceId);
      }
    },
    [connectedDevices, connectTmuxDevice]
  );

  const host = runtime.host;
  useEffect(() => {
    const currentDeviceId = routeDeviceId(location.pathname, (path) => hostAppPath(host, path));
    if (shouldEnsureRouteDeviceSubscription(currentDeviceId, devicesData)) {
      ensureDeviceSubscribed(currentDeviceId);
    }
  }, [location.pathname, devicesData, ensureDeviceSubscribed, host]);

  useEffect(() => {
    if (!devicesData) return;
    const knownDeviceIds = new Set(devicesData.devices.map((device) => device.id));
    for (const deviceId of connectedDevices) {
      if (!knownDeviceIds.has(deviceId)) {
        disconnectTmuxDevice(deviceId);
      }
    }
  }, [devicesData, connectedDevices, disconnectTmuxDevice]);

  const value = useMemo(() => ({ ensureDeviceSubscribed }), [ensureDeviceSubscribed]);

  return <GlobalDeviceContext.Provider value={value}>{children}</GlobalDeviceContext.Provider>;
}
