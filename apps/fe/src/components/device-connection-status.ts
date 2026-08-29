import type { DeviceConnectionStatus } from '@tmex/panels';
import type { PendingConnectionRequest, PendingConnectionSnapshot } from './device-intent-store';

export interface DeviceConnectionSnapshot {
  /** 用户主动断开的设备（连接意图），优先级最高 */
  intentionallyDisconnected: ReadonlySet<string>;
  /** tmux store 已订阅集合 */
  connectedDevices: ReadonlySet<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, unknown>;
  deviceReconnecting: Record<string, unknown>;
  /** 用户刚点下、还没落定的连接 / 断开请求：在飞期间稳定展示 connecting / disconnecting */
  pending?: PendingConnectionSnapshot;
}

/** 连接状态所依赖的 tmux store 切片（不含用户连接意图） */
export type DeviceRuntimeSlices = Omit<
  DeviceConnectionSnapshot,
  'intentionallyDisconnected' | 'pending'
>;

/** pending 态至少展示这么久，避免「连接 → 连接中 → 断开」在一帧内连跳三档 */
export const MIN_PENDING_STATUS_MS = 350;
/** 请求迟迟没有落定（网关没回音）时放弃 pending，回到真实推导态 */
export const MAX_PENDING_STATUS_MS = 8000;

export function createDeviceConnectionSnapshot(
  intentionallyDisconnected: ReadonlySet<string>,
  slices: DeviceRuntimeSlices,
  pending?: PendingConnectionSnapshot
): DeviceConnectionSnapshot {
  return { intentionallyDisconnected, ...slices, pending };
}

function ownValue<T>(record: Record<string, T | undefined>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function isDeviceConnected(
  deviceConnected: Record<string, boolean | undefined>,
  deviceId: string
): boolean {
  return ownValue(deviceConnected, deviceId) === true;
}

/** 不看在飞请求的真实推导态 */
export function deriveSettledConnectionStatus(
  deviceId: string,
  snapshot: DeviceConnectionSnapshot
): DeviceConnectionStatus {
  if (!deviceId) return 'disconnected';
  if (snapshot.intentionallyDisconnected.has(deviceId)) return 'disconnected';
  if (ownValue(snapshot.deviceReconnecting, deviceId)) return 'reconnecting';
  if (ownValue(snapshot.deviceErrors, deviceId)) return 'error';
  if (isDeviceConnected(snapshot.deviceConnected, deviceId)) return 'connected';
  if (snapshot.connectedDevices.has(deviceId)) return 'connecting';
  return 'disconnected';
}

export function deriveDeviceConnectionStatus(
  deviceId: string,
  snapshot: DeviceConnectionSnapshot
): DeviceConnectionStatus {
  if (!deviceId) return 'disconnected';
  const pending = snapshot.pending?.get(deviceId);
  if (pending) return pending.kind === 'connect' ? 'connecting' : 'disconnecting';
  return deriveSettledConnectionStatus(deviceId, snapshot);
}

/** 真实推导态已经到达请求的目标（或失败）了吗 */
export function isPendingRequestSettled(
  request: PendingConnectionRequest,
  settledStatus: DeviceConnectionStatus
): boolean {
  if (request.kind === 'connect') {
    return (
      settledStatus === 'connected' || settledStatus === 'error' || settledStatus === 'reconnecting'
    );
  }
  return settledStatus === 'disconnected';
}

export interface PendingSettlementPlan {
  /** 多少毫秒后执行（0 = 立刻） */
  delay: number;
  /** settle：正常摘掉；timeout：网关没回音，摘掉并把请求回滚成可重试的状态 */
  action: 'settle' | 'timeout';
}

/**
 * 在飞请求什么时候、以什么方式摘掉：落定且展示够了最短时长 → 立刻摘；落定但还没到最短时长 →
 * 补足剩余毫秒；没落定 → 到最长时长为止（到点按超时处理）。
 */
export function pendingSettlementPlan(
  request: PendingConnectionRequest,
  settledStatus: DeviceConnectionStatus,
  now: number
): PendingSettlementPlan {
  const elapsed = Math.max(0, now - request.at);
  if (isPendingRequestSettled(request, settledStatus)) {
    return { delay: Math.max(0, MIN_PENDING_STATUS_MS - elapsed), action: 'settle' };
  }
  return { delay: Math.max(0, MAX_PENDING_STATUS_MS - elapsed), action: 'timeout' };
}

export interface PendingSettlementActions {
  settle: (deviceId: string) => void;
  /**
   * connect 请求到最长时长仍没落定：设备还挂在订阅集合里，若不处理状态会永远停在 connecting、
   * 按钮永远禁用。这里记一个可重试的 timeout 错误，按钮回到「连接」。
   */
  timeoutConnect: (deviceId: string) => void;
  schedule: (callback: () => void, delay: number) => () => void;
}

/** 对全部在飞请求执行落定计划；返回取消已排定定时器的函数（effect cleanup 用） */
export function runPendingSettlement(
  pending: PendingConnectionSnapshot,
  snapshot: DeviceConnectionSnapshot,
  now: number,
  actions: PendingSettlementActions
): () => void {
  const cancels: Array<() => void> = [];
  for (const [deviceId, request] of pending) {
    const settled = deriveSettledConnectionStatus(deviceId, snapshot);
    const plan = pendingSettlementPlan(request, settled, now);
    const run = () => {
      if (plan.action === 'timeout' && request.kind === 'connect') actions.timeoutConnect(deviceId);
      actions.settle(deviceId);
    };
    if (plan.delay === 0) run();
    else cancels.push(actions.schedule(run, plan.delay));
  }
  return () => {
    for (const cancel of cancels) cancel();
  };
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

/** 已订阅但设备已从列表中删除，需要主动退订 */
export function selectStaleSubscribedDeviceIds(
  connectedDevices: ReadonlySet<string>,
  knownDeviceIds: ReadonlySet<string>
): string[] {
  return [...connectedDevices].filter((deviceId) => !knownDeviceIds.has(deviceId));
}

/** 持久化的连接意图中仍然存在、且尚未订阅的设备，需要恢复订阅 */
export function selectRestorableDeviceIds(
  persistedConnected: ReadonlySet<string>,
  knownDeviceIds: ReadonlySet<string>,
  intentionallyDisconnected: ReadonlySet<string>,
  connectedDevices: ReadonlySet<string>
): string[] {
  return [...persistedConnected].filter(
    (deviceId) =>
      knownDeviceIds.has(deviceId) &&
      shouldEnsureDeviceSubscription(deviceId, intentionallyDisconnected, connectedDevices)
  );
}
