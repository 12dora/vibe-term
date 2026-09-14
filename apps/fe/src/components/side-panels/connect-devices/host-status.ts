// 隧道公网入口的现状推导：把隧道状态折成候选地址要展示的结论。
// 与 React 无关，也不碰远程访问那套模块（一 import 就把它的 lazy chunk 拽进侧滑面板）。

import type { TunnelStatusResponse } from '@vibeterm/shared';

/** 公网入口的形态：命名隧道 / 临时隧道 / 什么都没有。 */
export type EntryKind = 'named' | 'quick' | 'none';

export interface EntryStatus {
  kind: EntryKind;
  url: string | null;
  /** 隧道是否在跑并且真的可达；`named` / `quick` 才有意义。 */
  running: boolean;
  /** 进程在跑但没有边缘连接：地址此时不可达，与「已停止」也要分开说。 */
  degraded: boolean;
  /** 命名隧道的主机名。 */
  hostname: string | null;
}

const NO_ENTRY: EntryStatus = {
  kind: 'none',
  url: null,
  running: false,
  degraded: false,
  hostname: null,
};

/** 接管来的隧道由系统服务跑，进程存活只能看探测结果（与 `tunnelPill` 同一条判据）。 */
function tunnelAlive(tunnel: TunnelStatusResponse): boolean {
  if (tunnel.config?.externallyManaged) return tunnel.external?.running === true;
  const state = tunnel.process?.state;
  return state === 'running' || state === 'degraded';
}

/**
 * 进程活着但连接器没有边缘连接。外部托管的 cloudflared 只探得到「进程在不在」，
 * 所以这里同时认后端给的 `degraded` 与连接器探测结果。
 * 探不到 metrics 端点（`reachable` 非 `true`）只说明读不到这份指标，不能据此宣告断线。
 */
function tunnelDegraded(tunnel: TunnelStatusResponse): boolean {
  if (!tunnelAlive(tunnel)) return false;
  if (tunnel.process?.state === 'degraded') return true;
  const connector = tunnel.connector;
  if (connector?.reachable !== true) return false;
  return (connector.readyConnections ?? 0) === 0;
}

/**
 * 整包跑测试时别的用例会往同一个查询键塞形状不完整的桩数据，字段一律按缺省处理而不是崩。
 */
export function entryStatus(tunnel: TunnelStatusResponse | null | undefined): EntryStatus {
  const config = tunnel?.config;
  const degraded = tunnel ? tunnelDegraded(tunnel) : false;
  const running = tunnel ? tunnelAlive(tunnel) && !degraded : false;
  if (config?.mode === 'named' && config.hostname) {
    return {
      kind: 'named',
      url: `https://${config.hostname}`,
      running,
      degraded,
      hostname: config.hostname,
    };
  }
  const quickUrl = config?.mode === 'quick' ? (tunnel?.process?.publicUrl ?? null) : null;
  if (quickUrl) return { kind: 'quick', url: quickUrl, running, degraded, hostname: null };
  return NO_ENTRY;
}
