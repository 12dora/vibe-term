// 一个 node（以 runtime 的 storagePrefix 标识）的设备连接意图**单一事实源**。
//
// 为什么必须放在 React 组件状态之外：
//  1. 路由层（`NodeRuntimeBoundary`）与侧边栏聚合视图（`NodeRuntimeScope`）会给**同一个 node**
//     各挂一份 `GlobalDeviceProvider`。意图若各存一份 `useState`，侧栏点的显式断开对路由层不可见，
//     路由层的自动订阅会立刻把设备连回来。
//  2. `/n/A/*` 导航到 `/n/B/*` 时 React Router 复用同一棵组件树，provider 不重挂。意图若靠
//     `useState` 初值 + effect 写回存储键，就会把 A 的集合写进 B 的键。
//
// 按 storagePrefix 取实例后，「集合来源」与「写回的键」永远同源，且同 prefix 全局唯一；
// 不同 node 各自成实例，聚合视图里多个 node 并存互不干扰。

import {
  type DeviceIdStorage,
  connectedDevicesKey,
  disconnectedDevicesKey,
  pruneUnknownDeviceIds,
  readPersistedIds,
  withDeviceId,
  withoutDeviceId,
  writePersistedIds,
} from './device-connection-persistence';
import {
  selectRestorableDeviceIds,
  selectStaleSubscribedDeviceIds,
} from './device-connection-status';

export interface DeviceIntentSnapshot {
  /** 用户希望保持连接的设备（跨刷新恢复订阅） */
  connected: ReadonlySet<string>;
  /** 用户主动断开的设备（抑制自动订阅） */
  disconnected: ReadonlySet<string>;
}

/**
 * 意图状态 + 持久化。写入永远落在本实例自己的两个键上，调用方无从指定键，
 * 因此不存在「集合来自 A、键指向 B」的错配。
 */
export class DeviceIntentStore {
  readonly connectedKey: string;
  readonly disconnectedKey: string;
  private readonly storage: DeviceIdStorage | null | undefined;
  private readonly listeners = new Set<() => void>();
  private connected: Set<string>;
  private disconnected: Set<string>;
  private snapshot: DeviceIntentSnapshot;

  constructor(storagePrefix: string, storage?: DeviceIdStorage | null) {
    this.connectedKey = connectedDevicesKey(storagePrefix);
    this.disconnectedKey = disconnectedDevicesKey(storagePrefix);
    this.storage = storage;
    this.connected = readPersistedIds(this.connectedKey, storage);
    this.disconnected = readPersistedIds(this.disconnectedKey, storage);
    this.snapshot = { connected: this.connected, disconnected: this.disconnected };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 快照对象只在意图变化时换新引用，满足 `useSyncExternalStore` 的缓存要求。 */
  getSnapshot = (): DeviceIntentSnapshot => this.snapshot;

  markConnectIntent = (deviceId: string): void => {
    if (!deviceId) return;
    this.commit(
      withDeviceId(this.connected, deviceId),
      withoutDeviceId(this.disconnected, deviceId)
    );
  };

  markDisconnectIntent = (deviceId: string): void => {
    if (!deviceId) return;
    this.commit(
      withoutDeviceId(this.connected, deviceId),
      withDeviceId(this.disconnected, deviceId)
    );
  };

  pruneToKnownDevices = (knownDeviceIds: ReadonlySet<string>): void => {
    const connected = pruneUnknownDeviceIds(this.connected, knownDeviceIds);
    const disconnected = pruneUnknownDeviceIds(this.disconnected, knownDeviceIds);
    this.commit(
      connected === this.connected ? null : connected,
      disconnected === this.disconnected ? null : disconnected
    );
  };

  private commit(connected: Set<string> | null, disconnected: Set<string> | null): void {
    if (!connected && !disconnected) return;
    if (connected) {
      this.connected = connected;
      writePersistedIds(this.connectedKey, connected, this.storage);
    }
    if (disconnected) {
      this.disconnected = disconnected;
      writePersistedIds(this.disconnectedKey, disconnected, this.storage);
    }
    this.snapshot = { connected: this.connected, disconnected: this.disconnected };
    for (const listener of [...this.listeners]) listener();
  }
}

const stores = new Map<string, DeviceIntentStore>();

/**
 * 取该 storagePrefix 的意图源（懒建）。同 prefix 恒返回同一实例——这正是「同一个 node 的
 * 连接意图是单一事实源」的实现方式；实例不随组件卸载释放（只有两个设备 id 集合，
 * 保留下来还能让短暂卸载后重挂的 provider 直接复用内存态）。
 */
export function deviceIntentStore(storagePrefix: string): DeviceIntentStore {
  let store = stores.get(storagePrefix);
  if (!store) {
    store = new DeviceIntentStore(storagePrefix);
    stores.set(storagePrefix, store);
  }
  return store;
}

export type PendingConnectionKind = 'connect' | 'disconnect';

export interface PendingConnectionRequest {
  kind: PendingConnectionKind;
  /** 发起时刻（ms），用来保证 pending 态至少展示一小段时间，按钮不闪 */
  at: number;
}

export type PendingConnectionSnapshot = ReadonlyMap<string, PendingConnectionRequest>;

const EMPTY_PENDING: PendingConnectionSnapshot = new Map();

/**
 * 用户刚点下的连接 / 断开请求（同一个 node 的多份 provider 共用）。
 * 与意图分开存：意图是持久化的「用户想要什么」，这里是转瞬即逝的「请求还没落定」，
 * 重复点同一方向不换快照（保留最早的发起时刻），落定后由 provider 摘掉。
 */
export class PendingConnectionRequests {
  private readonly listeners = new Set<() => void>();
  private snapshot: PendingConnectionSnapshot = EMPTY_PENDING;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PendingConnectionSnapshot => this.snapshot;

  begin = (deviceId: string, kind: PendingConnectionKind, at = Date.now()): void => {
    if (!deviceId) return;
    if (this.snapshot.get(deviceId)?.kind === kind) return;
    const next = new Map(this.snapshot);
    next.set(deviceId, { kind, at });
    this.commit(next);
  };

  settle = (deviceId: string): void => {
    if (!this.snapshot.has(deviceId)) return;
    const next = new Map(this.snapshot);
    next.delete(deviceId);
    this.commit(next.size === 0 ? EMPTY_PENDING : next);
  };

  private commit(next: PendingConnectionSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const pendingRequests = new Map<string, PendingConnectionRequests>();

/** 取该 storagePrefix 的在飞请求表（懒建）；同 prefix 恒返回同一实例。 */
export function pendingConnectionRequests(storagePrefix: string): PendingConnectionRequests {
  let store = pendingRequests.get(storagePrefix);
  if (!store) {
    store = new PendingConnectionRequests();
    pendingRequests.set(storagePrefix, store);
  }
  return store;
}

/** 测试用：丢弃实例表，让下一次取用重新从存储读取。 */
export function resetDeviceIntentStores(): void {
  stores.clear();
  pendingRequests.clear();
}

export interface DeviceSubscriptionActions {
  connectDevice: (deviceId: string) => void;
  disconnectDevice: (deviceId: string) => void;
}

/**
 * 设备列表就绪后的对账：清理已删除设备的意图、退订已消失的订阅、恢复持久化的连接意图。
 * 先 prune 再读快照，用的是**本 node** 的意图；显式断开的设备不会被恢复。
 */
export function reconcileDeviceSubscriptions(
  intent: DeviceIntentStore,
  knownDeviceIds: ReadonlySet<string>,
  connectedDevices: ReadonlySet<string>,
  actions: DeviceSubscriptionActions
): void {
  intent.pruneToKnownDevices(knownDeviceIds);
  const { connected, disconnected } = intent.getSnapshot();

  for (const deviceId of selectStaleSubscribedDeviceIds(connectedDevices, knownDeviceIds)) {
    actions.disconnectDevice(deviceId);
  }
  for (const deviceId of selectRestorableDeviceIds(
    connected,
    knownDeviceIds,
    disconnected,
    connectedDevices
  )) {
    actions.connectDevice(deviceId);
  }
}
