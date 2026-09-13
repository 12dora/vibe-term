// 中继链路行的语义层：一行该摆哪些徽标、哪些行可以「设为主中继」。纯函数，供行组件与单测共用。
//
// 两种形态：
// - 单条中继 / 旧网关（`multiAttach === false`）：与今天一模一样——地址 + 一枚状态徽标，
//   多于一条时行本身是选择器。
// - 多条同时挂载（`multiAttach === true`）：行不再是单选，每行各自摆身份、延迟、在线对端数
//   与 TURN；「设为主中继」是行尾的一个动作，主中继那行禁用。

import { relayPeersOnlineOf, relayRoleOf, relayTurnOf } from '@/node/relay-extras';
import type {
  RelayAttachRole,
  RelayAutoSelectView,
  RelayLinkStatus,
} from '@vibeterm/api-client/relay/tenant-api';
import type { RelaySwitchReason } from '@vibeterm/shared/relay';

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
 * 身份徽标之后的那一枚：这条主中继是**被固定的**还是**自动优选选出来的**。
 *
 * 两者互斥且固定优先：固定期间自动优选整个冻结，此时再摆「自动优选」只会误导。
 * 固定的那条即便暂时不是主中继（目标离线、已 failover 到别条）也照摆——
 * 它解释了链路恢复后为什么会自己切回去。旧网关两个字段都不下发，一枚都不出。
 */
export function relayPinBadge(row: RelayLinkStatus): RelayBadgeSpec | null {
  if (row.pinned === true) return { key: 'relay.tenant.strip.pinned', variant: 'outline' };
  if (row.autoSelected === true && relayRoleOf(row) === 'primary') {
    return { key: 'relay.tenant.strip.autoSelected', variant: 'outline' };
  }
  return null;
}

export interface RelayScoreHint {
  key: string;
  params: { ms: number };
  /** 悬停解释：这个数越小越好，不是延迟。 */
  titleKey: string;
}

/**
 * 自动优选打分。它不是延迟——延迟只是其中一项，还叠了路径与负载——所以紧跟在延迟后面
 * 另起一段，并带上「越小越好」的悬停解释。未连接 / 样本不足（网关不下发）时不出。
 */
export function relayScoreHint(row: RelayLinkStatus): RelayScoreHint | null {
  if (!row.online) return null;
  const score = row.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return null;
  return {
    key: 'relay.tenant.strip.score',
    params: { ms: Math.round(score) },
    titleKey: 'relay.tenant.strip.scoreTitle',
  };
}

export interface RelayAutoSelectState {
  /** `pinned` 给出「取消固定」，`auto` 只是一句陈述，`none` 整行不出。 */
  kind: 'pinned' | 'auto' | 'none';
  hintKey: string | null;
  /** 取消固定成功后的提示语 key；`pinned` 之外为 `null`。 */
  unpinDoneKey: string | null;
  /** 自动优选上次换主的时刻；未自动换过或已固定时为 `null`。 */
  lastSwitchAt: number | null;
}

const AUTO_SELECT_NONE: RelayAutoSelectState = Object.freeze({
  kind: 'none',
  hintKey: null,
  unpinDoneKey: null,
  lastSwitchAt: null,
});

/**
 * 网关 `isAutoSwitchReason` 的 FE 版。网关的 `noteAttached` 在任何一次 attach（含 `startup`）
 * 都会写 `lastSwitchAt`，只看这个字段会让「刚重启」读成「刚自动换过主」。
 */
function isAutoSwitchReason(reason: RelaySwitchReason | null): boolean {
  return reason === 'auto-rtt' || reason === 'auto-failover';
}

/** 固定态的两句文案：自动优选本来就没开时不能说「暂停 / 恢复」——它压根不会恢复。 */
function pinnedState(autoEnabled: boolean): RelayAutoSelectState {
  if (!autoEnabled) {
    return {
      kind: 'pinned',
      hintKey: 'relay.tenant.autoSelect.pinnedHintAutoOff',
      unpinDoneKey: 'relay.tenant.autoSelect.unpinDoneAutoOff',
      lastSwitchAt: null,
    };
  }
  return {
    kind: 'pinned',
    hintKey: 'relay.tenant.autoSelect.pinnedHint',
    unpinDoneKey: 'relay.tenant.autoSelect.unpinDone',
    lastSwitchAt: null,
  };
}

/**
 * 卡片上那一行「固定 / 自动优选」的状态。
 *
 * 固定优先：`preferredUrl` 一旦有值，自动优选就是冻结的，界面必须先说清这件事，
 * 否则用户会以为「自动优选已开启」还在起作用。两者都没有时整行不出。
 */
export function relayAutoSelectState(view: {
  preferredUrl: string | null;
  autoSelect: RelayAutoSelectView;
}): RelayAutoSelectState {
  const autoEnabled = view.autoSelect.enabled === true;
  if (view.preferredUrl !== null && view.preferredUrl.length > 0) return pinnedState(autoEnabled);
  if (!autoEnabled) return AUTO_SELECT_NONE;
  return {
    kind: 'auto',
    hintKey: 'relay.tenant.autoSelect.on',
    unpinDoneKey: null,
    lastSwitchAt: isAutoSwitchReason(view.autoSelect.switchReason)
      ? view.autoSelect.lastSwitchAt
      : null,
  };
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
