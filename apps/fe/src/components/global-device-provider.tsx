import { useQuery } from '@tanstack/react-query';
import { useTmuxStore } from '@tmex/stores';
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router';

interface GlobalDeviceContextValue {
  ensureDeviceSubscribed: (deviceId: string) => void;
}

const GlobalDeviceContext = createContext<GlobalDeviceContextValue | null>(null);

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
  const connectTmuxDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectTmuxDevice = useTmuxStore((state) => state.disconnectDevice);
  const connectedDevices = useTmuxStore((state) => state.connectedDevices);

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: Array<{ id: string }> }>;
    },
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

  useEffect(() => {
    const currentDeviceId = location.pathname.match(/^\/devices\/([^/]+)/)?.[1];
    if (shouldEnsureRouteDeviceSubscription(currentDeviceId, devicesData)) {
      ensureDeviceSubscribed(currentDeviceId);
    }
  }, [location.pathname, devicesData, ensureDeviceSubscribed]);

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
