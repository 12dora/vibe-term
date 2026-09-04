// 本机卡头部的两个派生量：唯一那枚状态徽标，与「更改角色」菜单里该给哪些目标角色。
//
// 状态只能有一枚：以前 hub 提示、中继链路条、租户提示各说各的，同一台机器能同时显示
// 「未连接」和「在线」。这里按上级形态收敛成一档，卡片其余部分不再自己下结论。

import type { LocalRole } from '@tmex/api-client/local/types';

export type MachineStatusTone = 'ok' | 'warn' | 'muted';

export type MachineStatusState =
  | 'standalone'
  | 'unknown'
  | 'hubConnected'
  | 'hubDisconnected'
  | 'connecting'
  | 'relayConnected'
  | 'relayDisconnected'
  | 'relayKicked';

export interface MachineStatusBadge {
  state: MachineStatusState;
  tone: MachineStatusTone;
  key: string;
  params?: { ms: number };
}

export interface MachineStatusInput {
  standalone: boolean;
  /**
   * `/api/local/status` 已经回来了。没回来（或失败）时本机角色未知：除了 `/api/auth/mode`
   * 直接给出的 standalone，其余一律不下结论——拿上级链路的快照去猜会说出「未连接 Hub」
   * 这种看着像故障的话。
   */
  roleKnown: boolean;
  relayMode: boolean;
  /** 中继模式下挂上了某一条中继。 */
  relayAttached: boolean;
  /** 中继令牌被作废，须重新输入口令。 */
  relayKicked: boolean;
  /** hub 模式下解析出了当前挂载的那台 hub。 */
  hubAttached: boolean;
  /** 首次探测仍在飞：还没有结论，不能说「未连接」。 */
  hubLoading: boolean;
  /** 当前链路的往返延迟；未知为 `null`。 */
  rttMs: number | null;
}

function connected(
  state: MachineStatusState,
  key: string,
  rttMs: number | null
): MachineStatusBadge {
  if (rttMs === null) return { state, tone: 'ok', key };
  return { state, tone: 'ok', key: `${key}Rtt`, params: { ms: Math.round(rttMs) } };
}

export function machineStatusBadge(input: MachineStatusInput): MachineStatusBadge {
  if (input.standalone) {
    return { state: 'standalone', tone: 'muted', key: 'nodes.machine.status.standalone' };
  }
  if (!input.roleKnown) {
    return { state: 'unknown', tone: 'muted', key: 'nodes.machine.status.unknown' };
  }
  if (input.relayMode) {
    if (input.relayKicked) {
      return { state: 'relayKicked', tone: 'warn', key: 'nodes.machine.status.relayKicked' };
    }
    if (input.relayAttached) {
      return connected('relayConnected', 'nodes.machine.status.relayConnected', input.rttMs);
    }
    return {
      state: 'relayDisconnected',
      tone: 'warn',
      key: 'nodes.machine.status.relayDisconnected',
    };
  }
  if (input.hubAttached) {
    return connected('hubConnected', 'nodes.machine.status.hubConnected', input.rttMs);
  }
  if (input.hubLoading) {
    return { state: 'connecting', tone: 'muted', key: 'nodes.machine.status.connecting' };
  }
  return { state: 'hubDisconnected', tone: 'warn', key: 'nodes.machine.status.hubDisconnected' };
}

/** 后端认的五个角色串（`packages/shared/src/roles.ts`）。 */
export const SELECTABLE_ROLES: LocalRole[] = [
  'standalone',
  'node',
  'hub,node',
  'relay,node',
  'relay',
];

/**
 * 「更改角色」菜单里的目标：当前角色不必再列，`standalone` 由单独的「离开…」承担
 * ——同一件事摆两遍只会让人以为是两条不同的路。
 */
export function roleMenuTargets(current: LocalRole): LocalRole[] {
  return SELECTABLE_ROLES.filter((role) => role !== current && role !== 'standalone');
}
