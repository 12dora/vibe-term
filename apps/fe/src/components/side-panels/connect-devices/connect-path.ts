// 「服务器或电脑」页的三条接入路径与默认选择：只按本机现状推导，与 React 无关。

import type { LocalRole } from '@tmex/api-client/local/types';

/** 一级：新机器怎么接进来。 */
export type ConnectPath = 'relay' | 'hub' | 'ssh';

/** 二级：加入现成的上级，还是先把本机搭成上级。 */
export type ConnectSide = 'join' | 'host';

export interface ConnectStatus {
  /** `/api/local/status` 的角色；拿不到（旧节点 / 未登录）时为 null。 */
  role: LocalRole | null;
  /** 本机的 uplink 已挂在某条中继上。 */
  relayAttached: boolean;
  /** 本机走中继模式。 */
  relayMode: boolean;
  /** 本机所在的租户；本机不是中继租户时为 null。 */
  tenantId: string | null;
  /** 本机已加入多节点互联。 */
  meshEnabled: boolean;
}

export function isRelayRole(role: LocalRole | null): boolean {
  return role === 'relay' || role === 'relay,node';
}

export function isHubRole(role: LocalRole | null): boolean {
  return role === 'hub,node';
}

export function defaultConnectPath(status: ConnectStatus): ConnectPath {
  if (isRelayRole(status.role) || status.relayMode) return 'relay';
  if (isHubRole(status.role) || status.meshEnabled) return 'hub';
  return 'relay';
}

/** 已有可加入的上级就先给「加入」，否则先教怎么把本机搭起来。 */
export function defaultConnectSide(path: ConnectPath, status: ConnectStatus): ConnectSide {
  // 中继侧只认稳定的租户接入模式：服务角色说明不了本机自己接没接上，
  // attached 又会随一次断线抖成 false。
  if (path === 'relay') {
    return status.relayMode && status.tenantId !== null ? 'join' : 'host';
  }
  if (path === 'hub') {
    return isHubRole(status.role) || (status.meshEnabled && !status.relayMode) ? 'join' : 'host';
  }
  return 'join';
}
