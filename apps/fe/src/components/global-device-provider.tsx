import { useQuery } from '@tanstack/react-query';
import { fetchDevices } from '@tmex/api-client';
import type { DeviceConnectionAdapter, DeviceConnectionStatus } from '@tmex/panels';
import { defaultRuntime, useTmuxStore } from '@tmex/stores';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';

const CONNECTED_STORAGE_KEY = `${defaultRuntime.storagePrefix}tmex:connectedDevices`;
const DISCONNECTED_STORAGE_KEY = `${defaultRuntime.storagePrefix}tmex:disconnectedDevices`;

interface GlobalDeviceContextValue {
  ensureDeviceSubscribed: (deviceId: string) => void;
  connection: DeviceConnectionAdapter;
}

const GlobalDeviceContext = createContext<GlobalDeviceContextValue | null>(null);

/** 仅需 get/set 的 Storage 子集，便于纯函数在无 DOM 环境下被测试 */
export interface DeviceIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: DeviceIdStorage | null): DeviceIdStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPersistedIds(key: string, storage?: DeviceIdStorage | null): Set<string> {
  const target = resolveStorage(storage);
  if (!target) return new Set<string>();
  try {
    const raw = target.getItem(key);
    if (!raw) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set<string>();
  }
}

export function writePersistedIds(
  key: string,
  ids: Iterable<string>,
  storage?: DeviceIdStorage | null
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(key, JSON.stringify([...ids]));
  } catch {
    // 忽略 localStorage 写入失败（隐私模式 / 配额）
  }
}

function ownValue<T>(record: Record<string, T | undefined>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export interface DeviceConnectionSnapshot {
  /** 用户主动断开的设备（连接意图），优先级最高 */
  intentionallyDisconnected: ReadonlySet<string>;
  /** tmux store 已订阅集合 */
  connectedDevices: ReadonlySet<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, unknown>;
  deviceReconnecting: Record<string, unknown>;
}

export function deriveDeviceConnectionStatus(
  deviceId: string,
  snapshot: DeviceConnectionSnapshot
): DeviceConnectionStatus {
  if (!deviceId) return 'disconnected';
  if (snapshot.intentionallyDisconnected.has(deviceId)) return 'disconnected';
  if (ownValue(snapshot.deviceReconnecting, deviceId)) return 'reconnecting';
  if (ownValue(snapshot.deviceErrors, deviceId)) return 'error';
  if (ownValue(snapshot.deviceConnected, deviceId) === true) return 'connected';
  if (snapshot.connectedDevices.has(deviceId)) return 'connecting';
  return 'disconnected';
}

export function shouldEnsureRouteDeviceSubscription(
  deviceId: string | undefined,
  devicesData: { devices: Array<{ id: string }> } | undefined
): deviceId is string {
  return Boolean(
    deviceId && (!devicesData || devicesData.devices.some((device) => device.id === deviceId))
  );
}

/** 自动订阅入口的判定：主动断开的设备不再自动订阅，已订阅的不重复下发 */
export function shouldEnsureDeviceSubscription(
  deviceId: string,
  intentionallyDisconnected: ReadonlySet<string>,
  connectedDevices: ReadonlySet<string>
): boolean {
  if (!deviceId) return false;
  if (intentionallyDisconnected.has(deviceId)) return false;
  return !connectedDevices.has(deviceId);
}

/** 清理已删除设备；无变化时返回原引用，避免 setState 触发多余渲染 */
export function pruneUnknownDeviceIds(
  ids: Set<string>,
  knownDeviceIds: ReadonlySet<string>
): Set<string> {
  const next = new Set<string>();
  let changed = false;
  for (const id of ids) {
    if (knownDeviceIds.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : ids;
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
  const clearDeviceError = useTmuxStore((state) => state.clearDeviceError);
  const connectedDevices = useTmuxStore((state) => state.connectedDevices);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const deviceErrors = useTmuxStore((state) => state.deviceErrors);
  const deviceReconnecting = useTmuxStore((state) => state.deviceReconnecting);

  const [persistedConnectedDeviceIds, setPersistedConnectedDeviceIds] = useState<Set<string>>(() =>
    readPersistedIds(CONNECTED_STORAGE_KEY)
  );
  const [explicitlyDisconnectedDeviceIds, setExplicitlyDisconnectedDeviceIds] = useState<
    Set<string>
  >(() => readPersistedIds(DISCONNECTED_STORAGE_KEY));

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(),
    throwOnError: false,
  });

  useEffect(() => {
    writePersistedIds(CONNECTED_STORAGE_KEY, persistedConnectedDeviceIds);
  }, [persistedConnectedDeviceIds]);

  useEffect(() => {
    writePersistedIds(DISCONNECTED_STORAGE_KEY, explicitlyDisconnectedDeviceIds);
  }, [explicitlyDisconnectedDeviceIds]);

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

  useEffect(() => {
    const currentDeviceId = location.pathname.match(/^\/devices\/([^/]+)/)?.[1];
    if (shouldEnsureRouteDeviceSubscription(currentDeviceId, devicesData)) {
      ensureDeviceSubscribed(currentDeviceId);
    }
  }, [location.pathname, devicesData, ensureDeviceSubscribed]);

  // 设备列表就绪后：清理已删除设备的连接意图与订阅，并恢复持久化的连接意图
  useEffect(() => {
    if (!devicesData) return;
    const knownDeviceIds = new Set(devicesData.devices.map((device) => device.id));

    setPersistedConnectedDeviceIds((prev) => pruneUnknownDeviceIds(prev, knownDeviceIds));
    setExplicitlyDisconnectedDeviceIds((prev) => pruneUnknownDeviceIds(prev, knownDeviceIds));

    for (const deviceId of connectedDevices) {
      if (!knownDeviceIds.has(deviceId)) {
        disconnectTmuxDevice(deviceId);
      }
    }

    for (const deviceId of persistedConnectedDeviceIds) {
      if (!knownDeviceIds.has(deviceId)) continue;
      if (
        shouldEnsureDeviceSubscription(deviceId, explicitlyDisconnectedDeviceIds, connectedDevices)
      ) {
        connectTmuxDevice(deviceId);
      }
    }
  }, [
    devicesData,
    connectedDevices,
    persistedConnectedDeviceIds,
    explicitlyDisconnectedDeviceIds,
    connectTmuxDevice,
    disconnectTmuxDevice,
  ]);

  const connect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      setExplicitlyDisconnectedDeviceIds((prev) => {
        if (!prev.has(deviceId)) return prev;
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
      setPersistedConnectedDeviceIds((prev) => {
        if (prev.has(deviceId)) return prev;
        const next = new Set(prev);
        next.add(deviceId);
        return next;
      });
      clearDeviceError(deviceId);
      connectTmuxDevice(deviceId);
    },
    [clearDeviceError, connectTmuxDevice]
  );

  const disconnect = useCallback(
    (deviceId: string) => {
      if (!deviceId) return;
      setExplicitlyDisconnectedDeviceIds((prev) => {
        if (prev.has(deviceId)) return prev;
        const next = new Set(prev);
        next.add(deviceId);
        return next;
      });
      setPersistedConnectedDeviceIds((prev) => {
        if (!prev.has(deviceId)) return prev;
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
      disconnectTmuxDevice(deviceId);
    },
    [disconnectTmuxDevice]
  );

  const connection = useMemo<DeviceConnectionAdapter>(() => {
    const snapshot: DeviceConnectionSnapshot = {
      intentionallyDisconnected: explicitlyDisconnectedDeviceIds,
      connectedDevices,
      deviceConnected,
      deviceErrors,
      deviceReconnecting,
    };
    return {
      isConnected: (deviceId) => ownValue(deviceConnected, deviceId) === true,
      status: (deviceId) => deriveDeviceConnectionStatus(deviceId, snapshot),
      isIntentionallyDisconnected: (deviceId) => explicitlyDisconnectedDeviceIds.has(deviceId),
      connect,
      disconnect,
    };
  }, [
    explicitlyDisconnectedDeviceIds,
    connectedDevices,
    deviceConnected,
    deviceErrors,
    deviceReconnecting,
    connect,
    disconnect,
  ]);

  const value = useMemo(
    () => ({ ensureDeviceSubscribed, connection }),
    [ensureDeviceSubscribed, connection]
  );

  return <GlobalDeviceContext.Provider value={value}>{children}</GlobalDeviceContext.Provider>;
}
