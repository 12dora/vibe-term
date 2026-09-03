// 设备连接面：connect/disconnect 与乐观 window/pane 重排。

import type { PaneSubscriptionManager } from './pane-subscriptions';
import type { RuntimeCore } from './runtime';
import type { TmuxSetState, TmuxState } from './tmux-state';
import { clearViewportPolicyForDevice } from './viewport-policy';

export type TmuxDeviceActions = Pick<
  TmuxState,
  'connectDevice' | 'disconnectDevice' | 'reorderWindows' | 'reorderPanes'
>;

export interface TmuxDeviceActionsDeps {
  getState: () => TmuxState;
  setState: TmuxSetState;
  shouldSkipDuplicateConnect: (deviceId: string) => boolean;
  lastConnectSentAt: Map<string, number>;
  cancelReselect: (deviceId: string) => void;
  paneSubscriptions: Pick<PaneSubscriptionManager, 'clearDevice'>;
}

/** 乐观重排：认识的 id 按请求顺序排在前面，其余条目保持原相对顺序追加在后；未知 id 丢弃 */
function reorderById<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const requested = new Set(ids);
  const known = ids.map((id) => byId.get(id)).filter((item) => item !== undefined);
  return [...known, ...items.filter((item) => !requested.has(item.id))];
}

export function createTmuxDeviceActions(
  core: RuntimeCore,
  deps: TmuxDeviceActionsDeps
): TmuxDeviceActions {
  return {
    connectDevice(deviceId) {
      if (!deviceId) return;

      deps.setState((prev) => {
        const nextConnected = new Set(prev.connectedDevices);
        nextConnected.add(deviceId);
        return { connectedDevices: nextConnected };
      });

      deps.getState().ensureSocketConnected();

      if (deps.shouldSkipDuplicateConnect(deviceId)) return;
      core.transport.send({ type: 'connect-device', deviceId });
    },

    disconnectDevice(deviceId) {
      if (!deviceId) return;

      // 主动断开立即落地断开态，不等网关 device-disconnected 事件
      deps.setState((prev) => {
        const nextConnected = new Set(prev.connectedDevices);
        nextConnected.delete(deviceId);
        return {
          connectedDevices: nextConnected,
          deviceConnected: { ...prev.deviceConnected, [deviceId]: false },
          deviceReconnecting: { ...prev.deviceReconnecting, [deviceId]: undefined },
          viewportPolicy: clearViewportPolicyForDevice(prev.viewportPolicy, deviceId),
        };
      });

      deps.lastConnectSentAt.delete(deviceId);
      core.selectMachine().cleanup(deviceId);
      deps.cancelReselect(deviceId);
      deps.paneSubscriptions.clearDevice(deviceId);
      core.transport.send({ type: 'disconnect-device', deviceId });
    },

    reorderWindows(deviceId, windowIds) {
      if (!deviceId || windowIds.length === 0) return;
      // 乐观本地重排，立即反馈；服务端会用带 overlay 的快照重广播确认
      deps.setState((prev) => {
        const snapshot = prev.snapshots[deviceId];
        const session = snapshot?.session;
        if (!session) return {};
        const windows = reorderById(session.windows, windowIds);
        return {
          snapshots: {
            ...prev.snapshots,
            [deviceId]: { ...snapshot, session: { ...session, windows } },
          },
        };
      });
      core.transport.send({ type: 'reorder-windows', deviceId, windowIds });
    },

    reorderPanes(deviceId, windowId, paneIds) {
      if (!deviceId || !windowId || paneIds.length === 0) return;
      deps.setState((prev) => {
        const snapshot = prev.snapshots[deviceId];
        const session = snapshot?.session;
        if (!session) return {};
        const windows = session.windows.map((w) =>
          w.id === windowId ? { ...w, panes: reorderById(w.panes, paneIds) } : w
        );
        return {
          snapshots: {
            ...prev.snapshots,
            [deviceId]: { ...snapshot, session: { ...session, windows } },
          },
        };
      });
      core.transport.send({ type: 'reorder-panes', deviceId, windowId, paneIds });
    },
  };
}
