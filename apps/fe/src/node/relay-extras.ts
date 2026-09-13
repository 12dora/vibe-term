// 多中继同时挂载（api-contract §B / §C）新增字段的读侧归一化。
//
// 这些字段在 `RelayLinkStatus` / `MeshNode` 上全是可选的：2.2.x 网关不下发，读侧一律按
// 「缺席 = 未知」处理，绝不把 `undefined` 当成 `false` / `0` 渲染成确定的结论。
//
// 这个模块在入口 chunk 的静态图里（`mesh-events-codec` / `merge-nodes` 都引它），因此**不放**
// 任何 `relay.*` / `nodes.*` 的文案 key——那些 key 在 rest 语言包里，写在这儿会让首屏解不出来。
// 文案映射一律留在各自的懒加载页面（`relay-row-model.ts` 等）。

import type {
  RelayAttachRole,
  RelayLinkStatus,
  RelayTurnProbe,
} from '@vibeterm/api-client/relay/tenant-api';

/**
 * 这一行的身份。
 *
 * 新网关直接下发 `role`，其中 `null` 是**确凿的**「这条没连上」，不再拿 `attached` 猜；
 * 旧网关整个字段都不下发（`undefined`），才按老语义折算——于是单条中继的界面与今天完全一致。
 */
export function relayRoleOf(row: RelayLinkStatus): RelayAttachRole | null {
  if (row.role === 'primary' || row.role === 'secondary') return row.role;
  if (row.role === null) return null;
  if (!row.online) return null;
  return row.attached ? 'primary' : 'secondary';
}

export function isPrimaryRelay(row: RelayLinkStatus): boolean {
  return relayRoleOf(row) === 'primary';
}

/** 该中继上在线的对端数；未连接或旧网关不下发为 `null`。 */
export function relayPeersOnlineOf(row: RelayLinkStatus): number | null {
  const value = row.peersOnline;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function turnMembersOf(members: RelayTurnProbe['members']): RelayTurnProbe['members'] | undefined {
  if (!members) return undefined;
  if (typeof members.ok !== 'number' || typeof members.total !== 'number') return undefined;
  if (!Number.isFinite(members.ok) || !Number.isFinite(members.total)) return undefined;
  if (members.ok < 0 || members.total < 0) return undefined;
  return {
    ok: Math.floor(members.ok),
    total: Math.floor(members.total),
    updatedAt:
      typeof members.updatedAt === 'number' && Number.isFinite(members.updatedAt)
        ? members.updatedAt
        : 0,
  };
}

/** 该中继广播的 TURN；地址为空一律当作没有。 */
export function relayTurnOf(row: RelayLinkStatus): RelayTurnProbe | null {
  const turn = row.turn;
  if (!turn || typeof turn.url !== 'string' || turn.url.length === 0) return null;
  const members = turnMembersOf(turn.members);
  return {
    url: turn.url,
    probeOk: typeof turn.probeOk === 'boolean' ? turn.probeOk : null,
    ...(members ? { members } : {}),
    ...(turn.localHint === 'tun' ? { localHint: 'tun' as const } : {}),
  };
}

export function viaRelayOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function relayPresenceOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/**
 * 中继地址 → 主机名。徽标与详情里只写主机名：协议固定是 HTTPS，端口对判断「经哪台中继」
 * 没有帮助，而地址一长就把整行挤掉。认不出的地址原样展示。
 */
export function relayHostLabel(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.length > 0 ? hostname : url;
  } catch {
    return url;
  }
}

/** 一串中继地址 → 「a、b」；供「在线于」那一行使用。 */
export function relayHostList(urls: readonly string[]): string {
  return urls.map(relayHostLabel).join('、');
}
