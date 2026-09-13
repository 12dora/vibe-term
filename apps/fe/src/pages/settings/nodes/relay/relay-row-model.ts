// 中继链路行的语义层：一行该摆哪些徽标、哪些行可以「设为主中继」。纯函数，供行组件与单测共用。
//
// 两种形态：
// - 单条中继 / 旧网关（`multiAttach === false`）：与今天一模一样——地址 + 一枚状态徽标，
//   多于一条时行本身是选择器。
// - 多条同时挂载（`multiAttach === true`）：行不再是单选，每行各自摆身份、延迟、在线对端数
//   与 TURN；「设为主中继」是行尾的一个动作，主中继那行禁用。

import { relayPeersOnlineOf, relayRoleOf, relayTurnOf } from '@/node/relay-extras';
import type { RelayAttachRole, RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';

/**
 * `turn:relay.example.com:3478?transport=udp` → `relay.example.com:3478`。
 * 协议与查询串对用户没有意义，认不出的地址原样展示。
 */
export function turnEndpointLabel(url: string): string {
  const withoutScheme = url.replace(/^turns?:/i, '');
  const [endpoint] = withoutScheme.split('?');
  return (endpoint ?? '').length > 0 ? (endpoint as string) : url;
}

/** TURN 探测结论的文案 key：可达 / 不可达 / 未探测。 */
export function turnProbeKey(probeOk: boolean | null): string {
  if (probeOk === true) return 'relay.tenant.strip.turnReachable';
  if (probeOk === false) return 'relay.tenant.strip.turnUnreachable';
  return 'relay.tenant.strip.turnUnprobed';
}

export interface RelayBadgeSpec {
  key: string;
  params?: Record<string, string | number>;
  /** `default` 是实心徽标（在线），`outline` 是描边（未连接 / 附属信息）。 */
  variant: 'default' | 'outline';
}

export type RelayTurnChipTone = 'default' | 'warning' | 'destructive';

export interface RelayTurnChip {
  /** `host:port`，不带协议与查询串。 */
  endpoint: string;
  /** 探测结论的文案 key。 */
  verdictKey: string;
  /** 舰队 tally 后缀 key；缺席表示旧网关没下发 members。 */
  membersKey?: string;
  membersParams?: { ok: number; total: number };
  reachable: boolean | null;
  tone: RelayTurnChipTone;
  /** `localHint=tun` 时的 tooltip key。 */
  titleKey?: string;
}

const ROLE_KEYS: Record<RelayAttachRole, string> = {
  primary: 'relay.tenant.strip.rolePrimary',
  secondary: 'relay.tenant.strip.roleSecondary',
};

/** 身份徽标：主中继 / 副中继 / 未连接。 */
export function relayRoleBadge(row: RelayLinkStatus): RelayBadgeSpec {
  const role = relayRoleOf(row);
  if (!role) return { key: 'relay.tenant.strip.roleDetached', variant: 'outline' };
  return { key: ROLE_KEYS[role], variant: role === 'primary' ? 'default' : 'outline' };
}

/**
 * 延迟徽标。多挂载下每条已连接的链路都有自己的心跳往返，都该摆出来；
 * 连着但还没出第一个样本时不出这枚徽标——写「延迟未知」只会让人以为链路有问题。
 */
export function relayRttBadge(row: RelayLinkStatus): RelayBadgeSpec | null {
  if (!row.online || typeof row.rttMs !== 'number' || !Number.isFinite(row.rttMs)) return null;
  return {
    key: 'relay.tenant.strip.rtt',
    params: { ms: Math.round(row.rttMs) },
    variant: 'outline',
  };
}

/** 「N 台在线」：该中继最近一次成员列表里在线的对端数；未连接或旧网关不下发时不出。 */
export function relayPeersBadge(row: RelayLinkStatus): RelayBadgeSpec | null {
  const peers = relayPeersOnlineOf(row);
  if (peers === null) return null;
  return { key: 'relay.tenant.strip.peersOnline', params: { n: peers }, variant: 'outline' };
}

function turnMembersSuffix(
  probeOk: boolean | null,
  members: { ok: number; total: number } | undefined
): Pick<RelayTurnChip, 'membersKey' | 'membersParams'> {
  if (!members) return {};
  if (probeOk === true) {
    return {
      membersKey: 'relay.tenant.strip.turnMembersCount',
      membersParams: { ok: members.ok, total: members.total },
    };
  }
  if (probeOk === false) {
    return {
      membersKey: 'relay.tenant.strip.turnMembersReachable',
      membersParams: { ok: members.ok, total: members.total },
    };
  }
  return {};
}

function turnChipTone(
  probeOk: boolean | null,
  members: { ok: number; total: number } | undefined
): RelayTurnChipTone {
  if (probeOk !== false) return 'default';
  if (members && members.ok > 0) return 'warning';
  return 'destructive';
}

export function relayTurnChip(row: RelayLinkStatus): RelayTurnChip | null {
  const turn = relayTurnOf(row);
  if (!turn) return null;
  return {
    endpoint: turnEndpointLabel(turn.url),
    verdictKey: turnProbeKey(turn.probeOk),
    ...turnMembersSuffix(turn.probeOk, turn.members),
    reachable: turn.probeOk,
    tone: turnChipTone(turn.probeOk, turn.members),
    ...(turn.localHint === 'tun' ? { titleKey: 'relay.tenant.strip.turnTunHint' } : {}),
  };
}

/**
 * 「设为主中继」在这一行是否可点。
 *
 * 主中继自己没什么可切的；被踢 / 没连上的那条切过去只会当场失败，不如先禁掉——
 * 行内已经用红字说清了原因。
 */
export function canSetPrimary(row: RelayLinkStatus): boolean {
  if (relayRoleOf(row) === 'primary') return false;
  if (row.kicked === true) return false;
  return row.online === true;
}

/**
 * 这份链路视图要不要按「多条同时挂载」渲染。
 * 网关明说 `multiAttach` 才算数：只有一条中继时界面与今天完全一致。
 */
export function isMultiAttachView(multiAttach: boolean | undefined, rows: readonly unknown[]) {
  return multiAttach === true && rows.length > 1;
}
