// 中继内置 TURN 的展示模型（契约 §D）。纯函数：运营面板与本机卡片共用同一份映射。
//
// 这一段不是配置项——TURN 随中继进程一起起，运营者能做的只有看状态与放行端口，
// 因此磁贴只回答三件事：开着没有、地址是什么、还差什么（防火墙 / 报错）。

import type { LocalRelayTurnStatus } from '@vibeterm/api-client/local/types';
import type { StatTileTone } from '@vibeterm/ui/stat-tile';

export type RelayTurnSource = LocalRelayTurnStatus['source'];

/**
 * `GET /api/relay/status` 与本机状态里新增的那一段（契约 §D）；旧中继不下发。
 * 两处同形，类型跟着本机状态那份走。
 */
export type RelayTurnStatus = LocalRelayTurnStatus;

export interface RelayTurnFirewallHint {
  port: number;
  range: string;
}

export interface RelayTurnView {
  /** 内置 / 外部 / 关闭。 */
  modeKey: string;
  /** 监听中 / 未监听 / 已关闭。 */
  stateKey: string;
  tone: StatTileTone;
  /** 当前分配数；关闭时为 `null`（没有数可报，摆 0 会像「在跑但没人用」）。 */
  allocations: number | null;
  /** `turn:<host>:<port>`，去掉查询串。 */
  endpoint: string | null;
  externalIp: string | null;
  error: string | null;
  /** 只有内置 TURN 才需要放行端口：外部 TURN 的端口不归这台机器管。 */
  firewall: RelayTurnFirewallHint | null;
}

const SOURCE_KEYS: Record<RelayTurnSource, string> = {
  builtin: 'relay.admin.turn.sourceBuiltin',
  external: 'relay.admin.turn.sourceExternal',
  off: 'relay.admin.turn.sourceOff',
};

function sourceOf(value: unknown): RelayTurnSource | null {
  return value === 'builtin' || value === 'external' || value === 'off' ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function portOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const port = Math.floor(value);
  return port > 0 && port <= 65535 ? port : null;
}

/** `turn:relay.example.com:3478?transport=udp` → `turn:relay.example.com:3478`。 */
export function turnEndpointText(url: string): string {
  const [endpoint] = url.split('?');
  return (endpoint ?? '').length > 0 ? (endpoint as string) : url;
}

/** 这份状态是不是一段能用的 TURN 描述；旧中继不下发时为 `null`，界面据此整块不出现。 */
export function relayTurnStatusOf(value: unknown): RelayTurnStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const source = sourceOf(raw.source);
  if (source === null) return null;
  return {
    enabled: raw.enabled === true,
    source,
    url: textOf(raw.url),
    port: portOf(raw.port),
    externalIp: textOf(raw.externalIp),
    listening: raw.listening === true,
    allocations: countOf(raw.allocations),
    error: textOf(raw.error),
    relayPortRange: textOf(raw.relayPortRange),
  };
}

function toneOf(turn: RelayTurnStatus): StatTileTone {
  if (turn.error) return 'destructive';
  if (!turn.enabled || turn.source === 'off') return 'muted';
  return turn.listening ? 'default' : 'warning';
}

function stateKeyOf(turn: RelayTurnStatus): string {
  if (!turn.enabled || turn.source === 'off') return 'relay.admin.turn.stateOff';
  return turn.listening ? 'relay.admin.turn.stateListening' : 'relay.admin.turn.stateStopped';
}

/**
 * 防火墙提示只在内置 TURN 且两个端口段都知道时出：少一半的提示比没有更糟，
 * 用户会以为只放行 3478 就够了（`relayPortRange` 才是媒体真正走的那一段）。
 */
function firewallOf(turn: RelayTurnStatus): RelayTurnFirewallHint | null {
  if (turn.source !== 'builtin' || !turn.enabled) return null;
  if (turn.port === null || turn.relayPortRange === null) return null;
  return { port: turn.port, range: turn.relayPortRange };
}

export function relayTurnView(turn: RelayTurnStatus): RelayTurnView {
  const off = !turn.enabled || turn.source === 'off';
  return {
    modeKey: SOURCE_KEYS[turn.source],
    stateKey: stateKeyOf(turn),
    tone: toneOf(turn),
    allocations: off ? null : turn.allocations,
    endpoint: turn.url ? turnEndpointText(turn.url) : null,
    externalIp: turn.externalIp,
    error: turn.error,
    firewall: firewallOf(turn),
  };
}
