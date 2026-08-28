import { useQuery } from '@tanstack/react-query';
import { type DevicesResponse, fetchDevices } from '@tmex/api-client';
import type { DeviceConnectionAdapter } from '@tmex/panels';
import { type HostServices, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import {
  type Dispatch,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { matchPath, useLocation } from 'react-router';
import {
  connectedDevicesKey,
  disconnectedDevicesKey,
  pruneUnknownDeviceIds,
  readPersistedIds,
  withDeviceId,
  withoutDeviceId,
  writePersistedIds,
} from './device-connection-persistence';
import {
  type DeviceRuntimeSlices,
  createDeviceConnectionSnapshot,
  deriveDeviceConnectionStatus,
  isDeviceConnected,
  selectRestorableDeviceIds,
  selectStaleSubscribedDeviceIds,
  shouldEnsureDeviceSubscription,
  shouldEnsureRouteDeviceSubscription,
} from './device-connection-status';

export type { DeviceIdStorage } from './device-connection-persistence';
export {
  pruneUnknownDeviceIds,
  readPersistedIds,
  writePersistedIds,
} from './device-connection-persistence';
export type { DeviceConnectionSnapshot } from './device-connection-status';
export {
  deriveDeviceConnectionStatus,
  shouldEnsureDeviceSubscription,
  shouldEnsureRouteDeviceSubscription,
} from './device-connection-status';

interface GlobalDeviceContextValue {
  ensureDeviceSubscribed: (deviceId: string) => void;
  connection: DeviceConnectionAdapter;
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

export function useGlobalDevice(): GlobalDeviceContextValue {
  const ctx = useContext(GlobalDeviceContext);
  if (!ctx) {
    throw new Error('useGlobalDevice must be used within GlobalDeviceProvider');
  }
  return ctx;
}

type DeviceIdSetState = [Set<string>, Dispatch<SetStateAction<Set<string>>>];

function usePersistedDeviceIds(storageKey: string): DeviceIdSetState {
  const [ids, setIds] = useState<Set<string>>(() => readPersistedIds(storageKey));
  useEffect(() => {
    writePersistedIds(storageKey, ids);
  }, [storageKey, ids]);
  return [ids, setIds];
}

interface DeviceIntentState {
  persistedConnectedDeviceIds: Set<string>;
  explicitlyDisconnectedDeviceIds: Set<string>;
  markConnectIntent: (deviceId: string) => void;
  markDisconnectIntent: (deviceId: string) => void;
  pruneToKnownDevices: (knownDeviceIds: ReadonlySet<string>) => void;
}

// 连接意图按 runtime 的 storagePrefix 隔离：self 前缀为空（沿用旧键），其余 node 各自成键，
// 免得多 node 的同名设备 id 在同一个 localStorage 键里互相覆盖。
function useDeviceIntentState(storagePrefix: string): DeviceIntentState {
  const [persistedConnectedDeviceIds, setPersistedConnectedDeviceIds] = usePersistedDeviceIds(
    connectedDevicesKey(storagePrefix)
  );
  const [explicitlyDisconnectedDeviceIds, setExplicitlyDisconnectedDeviceIds] =
    usePersistedDeviceIds(disconnectedDevicesKey(storagePrefix));

  const markConnectIntent = useCallback(
    (deviceId: string) => {
      setExplicitlyDisconnectedDeviceIds((prev) => withoutDeviceId(prev, deviceId) ?? prev);
      setPersistedConnectedDeviceIds((prev) => withDeviceId(prev, deviceId) ?? prev);
    },
    [setExplicitlyDisconnectedDeviceIds, setPersistedConnectedDeviceIds]
  );

  const markDisconnectIntent = useCallback(
    (deviceId: string) => {
      setExplicitlyDisconnectedDeviceIds((prev) => withDeviceId(prev, deviceId) ?? prev);
      setPersistedConnectedDeviceIds((prev) => withoutDeviceId(prev, deviceId) ?? prev);
    },
    [setExplicitlyDisconnectedDeviceIds, setPersistedConnectedDeviceIds]
  );

  const pruneToKnownDevices = useCallback(
    (knownDeviceIds: ReadonlySet<string>) => {
      setPersistedConnectedDeviceIds((prev) => pruneUnknownDeviceIds(prev, knownDeviceIds));
      setExplicitlyDisconnectedDeviceIds((prev) => pruneUnknownDeviceIds(prev, knownDeviceIds));
    },
    [setPersistedConnectedDeviceIds, setExplicitlyDisconnectedDeviceIds]
  );

  return {
    persistedConnectedDeviceIds,
    explicitlyDisconnectedDeviceIds,
    markConnectIntent,
    markDisconnectIntent,
    pruneToKnownDevices,
  };
}

function useDeviceStatusSlices(): DeviceRuntimeSlices {
  return {
    connectedDevices: useTmuxStore((state) => state.connectedDevices),
    deviceConnected: useTmuxStore((state) => state.deviceConnected),
    deviceErrors: useTmuxStore((state) => state.deviceErrors),
    deviceReconnecting: useTmuxStore((state) => state.deviceReconnecting),
  };
}

interface DeviceStoreActions {
  connectTmuxDevice: (deviceId: string) => void;
  disconnectTmuxDevice: (deviceId: string) => void;
  clearDeviceError: (deviceId: string) => void;
}

function useDeviceStoreActions(): DeviceStoreActions {
  return {
    connectTmuxDevice: useTmuxStore((state) => state.connectDevice),
    disconnectTmuxDevice: useTmuxStore((state) => state.disconnectDevice),
    clearDeviceError: useTmuxStore((state) => state.clearDeviceError),
  };
}

interface ReconcileParams {
  devicesData: DevicesResponse | undefined;
  connectedDevices: ReadonlySet<string>;
  intent: DeviceIntentState;
  connectTmuxDevice: (deviceId: string) => void;
  disconnectTmuxDevice: (deviceId: string) => void;
}

/** 设备列表就绪后：清理已删除设备的连接意图与订阅，并恢复持久化的连接意图 */
function useReconcileWithDeviceList({
  devicesData,
  connectedDevices,
  intent,
  connectTmuxDevice,
  disconnectTmuxDevice,
}: ReconcileParams): void {
  const { persistedConnectedDeviceIds, explicitlyDisconnectedDeviceIds, pruneToKnownDevices } =
    intent;

  useEffect(() => {
    if (!devicesData) return;
    const knownDeviceIds = new Set(devicesData.devices.map((device) => device.id));
    pruneToKnownDevices(knownDeviceIds);

    for (const deviceId of selectStaleSubscribedDeviceIds(connectedDevices, knownDeviceIds)) {
      disconnectTmuxDevice(deviceId);
    }
    const restorable = selectRestorableDeviceIds(
      persistedConnectedDeviceIds,
      knownDeviceIds,
      explicitlyDisconnectedDeviceIds,
      connectedDevices
    );
    for (const deviceId of restorable) {
      connectTmuxDevice(deviceId);
    }
  }, [
    devicesData,
    connectedDevices,
    persistedConnectedDeviceIds,
    explicitlyDisconnectedDeviceIds,
    pruneToKnownDevices,
    connectTmuxDevice,
    disconnectTmuxDevice,
  ]);
}

function useRouteDeviceSubscription(
  host: HostServices,
  devicesData: DevicesResponse | undefined,
  ensureDeviceSubscribed: (deviceId: string) => void
): void {
  const location = useLocation();
  useEffect(() => {
    const currentDeviceId = routeDeviceId(location.pathname, (path) => hostAppPath(host, path));
    if (shouldEnsureRouteDeviceSubscription(currentDeviceId, devicesData)) {
      ensureDeviceSubscribed(currentDeviceId);
    }
  }, [location.pathname, devicesData, ensureDeviceSubscribed, host]);
}

function useIntentActions(
  intent: DeviceIntentState,
  actions: DeviceStoreActions
): Pick<DeviceConnectionAdapter, 'connect' | 'disconnect'> {
  const { markConnectIntent, markDisconnectIntent } = intent;
  const { connectTmuxDevice, disconnectTmuxDevice, clearDeviceError } = actions;

  const connect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      markConnectIntent(deviceId);
      clearDeviceError(deviceId);
      connectTmuxDevice(deviceId);
    },
    [markConnectIntent, clearDeviceError, connectTmuxDevice]
  );

  const disconnect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      markDisconnectIntent(deviceId);
      disconnectTmuxDevice(deviceId);
    },
    [markDisconnectIntent, disconnectTmuxDevice]
  );

  return { connect, disconnect };
}

function useDeviceConnectionAdapter(
  intentionallyDisconnected: ReadonlySet<string>,
  slices: DeviceRuntimeSlices,
  intentActions: Pick<DeviceConnectionAdapter, 'connect' | 'disconnect'>
): DeviceConnectionAdapter {
  const { connectedDevices, deviceConnected, deviceErrors, deviceReconnecting } = slices;
  const { connect, disconnect } = intentActions;

  return useMemo<DeviceConnectionAdapter>(() => {
    const snapshot = createDeviceConnectionSnapshot(intentionallyDisconnected, {
      connectedDevices,
      deviceConnected,
      deviceErrors,
      deviceReconnecting,
    });
    return {
      isConnected: (deviceId) => isDeviceConnected(deviceConnected, deviceId),
      status: (deviceId) => deriveDeviceConnectionStatus(deviceId, snapshot),
      isIntentionallyDisconnected: (deviceId) => intentionallyDisconnected.has(deviceId),
      connect,
      disconnect,
    };
  }, [
    intentionallyDisconnected,
    connectedDevices,
    deviceConnected,
    deviceErrors,
    deviceReconnecting,
    connect,
    disconnect,
  ]);
}

interface GlobalDeviceProviderProps {
  children: React.ReactNode;
}

export function GlobalDeviceProvider({ children }: GlobalDeviceProviderProps) {
  const runtime = useRuntime();
  const actions = useDeviceStoreActions();
  const slices = useDeviceStatusSlices();
  const intent = useDeviceIntentState(runtime.storagePrefix);
  const { explicitlyDisconnectedDeviceIds } = intent;
  const { connectedDevices } = slices;
  const { connectTmuxDevice, disconnectTmuxDevice } = actions;

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const ensureDeviceSubscribed = useCallback(
    (deviceId: string) => {
      if (
        shouldEnsureDeviceSubscription(deviceId, explicitlyDisconnectedDeviceIds, connectedDevices)
      ) {
        connectTmuxDevice(deviceId);
      }
    },
    [explicitlyDisconnectedDeviceIds, connectedDevices, connectTmuxDevice]
  );

  useRouteDeviceSubscription(runtime.host, devicesData, ensureDeviceSubscribed);
  useReconcileWithDeviceList({
    devicesData,
    connectedDevices,
    intent,
    connectTmuxDevice,
    disconnectTmuxDevice,
  });

  const intentActions = useIntentActions(intent, actions);
  const connection = useDeviceConnectionAdapter(
    explicitlyDisconnectedDeviceIds,
    slices,
    intentActions
  );

  const value = useMemo(
    () => ({ ensureDeviceSubscribed, connection }),
    [ensureDeviceSubscribed, connection]
  );

  return <GlobalDeviceContext.Provider value={value}>{children}</GlobalDeviceContext.Provider>;
}
