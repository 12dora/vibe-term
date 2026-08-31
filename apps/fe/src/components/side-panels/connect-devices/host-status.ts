// 「本机作为中继」分支的现状推导：把隧道状态与 `/api/auth/mode` 折成三步各自要展示的结论。
// 与 React 无关，也不碰远程访问那套模块（一 import 就把它的 lazy chunk 拽进侧滑面板）。

import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { TunnelStatusResponse } from '@tmex/shared';

/** 公网入口的形态：命名隧道 / 临时隧道 / 只有 Hub 公开地址（直接连接） / 什么都没有。 */
export type EntryKind = 'named' | 'quick' | 'hubUrl' | 'none';

export interface EntryStatus {
  kind: EntryKind;
  url: string | null;
  /** 隧道是否在跑；`named` / `quick` 才有意义。 */
  running: boolean;
  /** 命名隧道的主机名，用来和 Hub 公开地址比对。 */
  hostname: string | null;
}

const NO_ENTRY: EntryStatus = { kind: 'none', url: null, running: false, hostname: null };

/** 接管来的隧道由系统服务跑，运行态只能看探测结果（与 `tunnelPill` 同一条判据）。 */
function tunnelRunning(tunnel: TunnelStatusResponse): boolean {
  if (tunnel.config?.externallyManaged) return tunnel.external?.running === true;
  return tunnel.process?.state === 'running';
}

/**
 * 整包跑测试时别的用例会往同一个查询键塞形状不完整的桩数据，字段一律按缺省处理而不是崩。
 * 隧道没配（或还没拉到）时退回 Hub 公开地址：直接连接没有任何本地标记，那个地址就是唯一证据。
 */
export function entryStatus(
  tunnel: TunnelStatusResponse | null | undefined,
  hubPublicUrl: string | null | undefined
): EntryStatus {
  const config = tunnel?.config;
  const running = tunnel ? tunnelRunning(tunnel) : false;
  if (config?.mode === 'named' && config.hostname) {
    return {
      kind: 'named',
      url: `https://${config.hostname}`,
      running,
      hostname: config.hostname,
    };
  }
  const quickUrl = config?.mode === 'quick' ? (tunnel?.process?.publicUrl ?? null) : null;
  if (quickUrl) return { kind: 'quick', url: quickUrl, running, hostname: null };
  if (hubPublicUrl) return { kind: 'hubUrl', url: hubPublicUrl, running: false, hostname: null };
  return NO_ENTRY;
}

/** 本机在 mesh 里的角色：自己是 Hub / 已作为节点接入别的 Hub / 还没组网。 */
export type HubRole = 'self' | 'node' | 'standalone';

export interface HubStatus {
  role: HubRole;
  url: string | null;
  /** Hub 公开地址与当前命名隧道的主机名对不上：别的机器多半接不进来。 */
  mismatch: boolean;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function hubStatus(
  mode: AuthModeResponse | null | undefined,
  entry: EntryStatus
): HubStatus {
  if (mode?.mode !== 'mesh') return { role: 'standalone', url: null, mismatch: false };
  const url = mode.hubPublicUrl ?? null;
  if (!mode.hubNodeId || mode.hubNodeId !== mode.nodeId) {
    return { role: 'node', url, mismatch: false };
  }
  const mismatch =
    entry.kind === 'named' && entry.hostname !== null && url !== null
      ? hostnameOf(url) !== entry.hostname
      : false;
  return { role: 'self', url, mismatch };
}
