// pane 订阅面：挂载引用计数、手动订阅集合、订阅代数（generation），
// 以及基于订阅关系的截屏 / 历史分页请求。

import { type GatewayHistoryCursor, generateSelectToken } from '@vibeterm/ws-client';
import type { RuntimeCore } from './runtime';

const SCREEN_BYTE_LIMIT = 512 * 1024;
/** LAN / 未知 RTT 的页大小。 */
export const HISTORY_PAGE_BYTE_LIMIT = 256 * 1024;
/**
 * 高 RTT 时向这个上限靠。网关 `CANONICAL_MAX_HISTORY_PAGE_BYTES` 会再 clamp 一次；
 * 请求超过服务端 cap 不会被拒。
 */
export const CANONICAL_MAX_HISTORY_PAGE_BYTES = 1024 * 1024;
const HISTORY_PAGE_RTT_FLOOR_MS = 200;
const HISTORY_PAGE_RTT_CEILING_MS = 800;

/**
 * 按链路 RTT 选 history 页字节上限：低延迟保持 256 KiB，800 ms 用满 cap，减少翻页往返。
 * 游标契约不变，调用方仍一次只发一页。
 */
export function historyPageByteLimit(
  rttMs: number | null | undefined,
  maxBytes: number = CANONICAL_MAX_HISTORY_PAGE_BYTES
): number {
  const cap = Math.max(HISTORY_PAGE_BYTE_LIMIT, maxBytes);
  if (cap === HISTORY_PAGE_BYTE_LIMIT) return HISTORY_PAGE_BYTE_LIMIT;
  if (rttMs == null || !Number.isFinite(rttMs) || rttMs <= HISTORY_PAGE_RTT_FLOOR_MS) {
    return HISTORY_PAGE_BYTE_LIMIT;
  }
  const span = HISTORY_PAGE_RTT_CEILING_MS - HISTORY_PAGE_RTT_FLOOR_MS;
  const t = Math.min(1, (rttMs - HISTORY_PAGE_RTT_FLOOR_MS) / span);
  return Math.round(HISTORY_PAGE_BYTE_LIMIT + t * (cap - HISTORY_PAGE_BYTE_LIMIT));
}

export interface PaneSubscriptionManager {
  /** 当前应订阅的 pane（手动订阅 ∪ 挂载中 pane），已排序去重 */
  currentPaneSubscriptions(deviceId: string): string[];
  /** 递增 generation 并下发全量订阅集合 */
  sendPaneSubscriptions(deviceId: string): void;
  setManualSubscriptions(deviceId: string, paneIds: string[]): void;
  /** 终端实例挂载，返回释放函数（幂等） */
  mountPane(deviceId: string, paneId: string): () => void;
  requestPaneScreen(deviceId: string, paneId: string): void;
  fetchPaneHistory(deviceId: string, paneId: string, cursor: GatewayHistoryCursor | null): void;
  /** 遍历挂载中的 pane（rebase 广播用） */
  forEachMountedPane(visit: (deviceId: string, paneId: string) => void): void;
  clearDevice(deviceId: string): void;
}

export function createPaneSubscriptionManager(core: RuntimeCore): PaneSubscriptionManager {
  const mountedPaneCounts = new Map<string, Map<string, number>>();
  const manualPaneSubscriptions = new Map<string, Set<string>>();
  const subscriptionGenerations = new Map<string, bigint>();

  function currentPaneSubscriptions(deviceId: string): string[] {
    const panes = new Set(manualPaneSubscriptions.get(deviceId) ?? []);
    for (const [paneId, count] of mountedPaneCounts.get(deviceId) ?? []) {
      if (count > 0) panes.add(paneId);
    }
    return [...panes].sort();
  }

  function sendPaneSubscriptions(deviceId: string): void {
    const generation = (subscriptionGenerations.get(deviceId) ?? 0n) + 1n;
    subscriptionGenerations.set(deviceId, generation);
    core.transport.send({
      type: 'set-pane-subscriptions',
      deviceId,
      generation,
      paneIds: currentPaneSubscriptions(deviceId),
    });
  }

  return {
    currentPaneSubscriptions,
    sendPaneSubscriptions,

    setManualSubscriptions(deviceId, paneIds) {
      manualPaneSubscriptions.set(deviceId, new Set(paneIds));
      sendPaneSubscriptions(deviceId);
    },

    mountPane(deviceId, paneId) {
      const counts = mountedPaneCounts.get(deviceId) ?? new Map<string, number>();
      mountedPaneCounts.set(deviceId, counts);
      counts.set(paneId, (counts.get(paneId) ?? 0) + 1);
      sendPaneSubscriptions(deviceId);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = mountedPaneCounts.get(deviceId);
        if (!current) return;
        const nextCount = (current.get(paneId) ?? 1) - 1;
        if (nextCount > 0) current.set(paneId, nextCount);
        else current.delete(paneId);
        if (current.size === 0) mountedPaneCounts.delete(deviceId);
        sendPaneSubscriptions(deviceId);
      };
    },

    requestPaneScreen(deviceId, paneId) {
      core.transport.send({
        type: 'request-pane-screen',
        requestId: generateSelectToken(),
        deviceId,
        paneId,
        byteLimit: SCREEN_BYTE_LIMIT,
      });
    },

    fetchPaneHistory(deviceId, paneId, cursor) {
      core.transport.send({
        type: 'request-pane-history',
        requestId: generateSelectToken(),
        deviceId,
        paneId,
        cursor,
        byteLimit: historyPageByteLimit(core.transport.latencyMs),
      });
    },

    forEachMountedPane(visit) {
      for (const [deviceId, panes] of mountedPaneCounts) {
        for (const paneId of panes.keys()) {
          visit(deviceId, paneId);
        }
      }
    },

    clearDevice(deviceId) {
      manualPaneSubscriptions.delete(deviceId);
      mountedPaneCounts.delete(deviceId);
      subscriptionGenerations.delete(deviceId);
    },
  };
}
