import { useQuery } from '@tanstack/react-query';
import { type DevicesResponse, fetchDevices } from '@tmex/api-client';
import type { DeviceConnectionAdapter } from '@tmex/panels';
import { type AppRuntime, type HostServices, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { matchPath, useLocation } from 'react-router';
import {
  type DeviceRuntimeSlices,
  createDeviceConnectionSnapshot,
  deriveDeviceConnectionStatus,
  isDeviceConnected,
  shouldEnsureDeviceSubscription,
  shouldEnsureRouteDeviceSubscription,
} from './device-connection-status';
import {
  type DeviceIntentSnapshot,
  type DeviceIntentStore,
  deviceIntentStore,
  reconcileDeviceSubscriptions,
} from './device-intent-store';

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

// 连接意图按 runtime 的 storagePrefix 隔离：self 前缀为空（沿用旧键），其余 node 各自成键，
// 免得多 node 的同名设备 id 在同一个 localStorage 键里互相覆盖。
//
// 状态本体在 React 之外（见 `device-intent-store.ts`），这里只做订阅：
//  - storagePrefix 变了（同一挂载下路由从 `/n/A` 切到 `/n/B`）就换订阅源，绝不搬运旧集合；
//  - 同一个 node 的多份 provider 拿到同一个实例，任一处的意图变更对其余实例立即可见。
function useDeviceIntent(storagePrefix: string): {
  store: DeviceIntentStore;
  snapshot: DeviceIntentSnapshot;
} {
  const store = deviceIntentStore(storagePrefix);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, snapshot };
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
  intentStore: DeviceIntentStore;
  connectTmuxDevice: (deviceId: string) => void;
  disconnectTmuxDevice: (deviceId: string) => void;
}

/** 设备列表就绪后：清理已删除设备的连接意图与订阅，并恢复持久化的连接意图 */
function useReconcileWithDeviceList({
  devicesData,
  connectedDevices,
  intentStore,
  connectTmuxDevice,
  disconnectTmuxDevice,
}: ReconcileParams): void {
  useEffect(() => {
    if (!devicesData) return;
    const knownDeviceIds = new Set(devicesData.devices.map((device) => device.id));
    reconcileDeviceSubscriptions(intentStore, knownDeviceIds, connectedDevices, {
      connectDevice: connectTmuxDevice,
      disconnectDevice: disconnectTmuxDevice,
    });
  }, [devicesData, connectedDevices, intentStore, connectTmuxDevice, disconnectTmuxDevice]);
}

/**
 * 当前路由指向的设备自动订阅。意图从 store 现读（而不是渲染期快照）：同一个 node 的另一份
 * provider 刚刚写下的显式断开，在本 effect 里必须已经可见，否则会立刻把它连回来。
 */
function useRouteDeviceSubscription(
  host: HostServices,
  devicesData: DevicesResponse | undefined,
  connectedDevices: ReadonlySet<string>,
  intentStore: DeviceIntentStore,
  connectTmuxDevice: (deviceId: string) => void
): void {
  const location = useLocation();
  useEffect(() => {
    const currentDeviceId = routeDeviceId(location.pathname, (path) => hostAppPath(host, path));
    if (!shouldEnsureRouteDeviceSubscription(currentDeviceId, devicesData)) return;
    const { disconnected } = intentStore.getSnapshot();
    if (shouldEnsureDeviceSubscription(currentDeviceId, disconnected, connectedDevices)) {
      connectTmuxDevice(currentDeviceId);
    }
  }, [location.pathname, devicesData, connectedDevices, intentStore, connectTmuxDevice, host]);
}

function useIntentActions(
  intentStore: DeviceIntentStore,
  actions: DeviceStoreActions
): Pick<DeviceConnectionAdapter, 'connect' | 'disconnect'> {
  const { connectTmuxDevice, disconnectTmuxDevice, clearDeviceError } = actions;

  const connect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      intentStore.markConnectIntent(deviceId);
      clearDeviceError(deviceId);
      connectTmuxDevice(deviceId);
    },
    [intentStore, clearDeviceError, connectTmuxDevice]
  );

  const disconnect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      intentStore.markDisconnectIntent(deviceId);
      disconnectTmuxDevice(deviceId);
    },
    [intentStore, disconnectTmuxDevice]
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

/**
 * 对外暴露的自动订阅入口（设备树展开等处调用）。意图与已订阅集合都从 store 现读：
 * 调用点可能发生在别处刚改完意图之后的同一个 tick 里。
 */
function useEnsureDeviceSubscribed(
  runtime: AppRuntime,
  intentStore: DeviceIntentStore
): (deviceId: string) => void {
  return useCallback(
    (deviceId: string) => {
      const tmux = runtime.stores.tmux.getState();
      const { disconnected } = intentStore.getSnapshot();
      if (shouldEnsureDeviceSubscription(deviceId, disconnected, tmux.connectedDevices)) {
        tmux.connectDevice(deviceId);
      }
    },
    [runtime, intentStore]
  );
}

interface GlobalDeviceProviderProps {
  children: React.ReactNode;
}

export function GlobalDeviceProvider({ children }: GlobalDeviceProviderProps) {
  const runtime = useRuntime();
  const actions = useDeviceStoreActions();
  const slices = useDeviceStatusSlices();
  const { store: intentStore, snapshot: intent } = useDeviceIntent(runtime.storagePrefix);
  const { connectedDevices } = slices;
  const { connectTmuxDevice, disconnectTmuxDevice } = actions;

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const ensureDeviceSubscribed = useEnsureDeviceSubscribed(runtime, intentStore);

  useRouteDeviceSubscription(
    runtime.host,
    devicesData,
    connectedDevices,
    intentStore,
    connectTmuxDevice
  );
  useReconcileWithDeviceList({
    devicesData,
    connectedDevices,
    intentStore,
    connectTmuxDevice,
    disconnectTmuxDevice,
  });

  const intentActions = useIntentActions(intentStore, actions);
  const connection = useDeviceConnectionAdapter(intent.disconnected, slices, intentActions);

  const value = useMemo(
    () => ({ ensureDeviceSubscribed, connection }),
    [ensureDeviceSubscribed, connection]
  );

  return <GlobalDeviceContext.Provider value={value}>{children}</GlobalDeviceContext.Provider>;
}
