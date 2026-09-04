// 角色切换的分类：五个角色两两组合，路由逻辑集中在这里，组件只管展示。
//
// `standalone → 任意角色` 走现成的 setup 向导（不动 API）；`→ standalone` 要退出并重启；
// `mesh → 另一个角色` 没有直达路径——后端的 setup 端点只接受 standalone，
// 因此拆成「先退出、重启回 standalone、再开对应向导」两步，靠 sessionStorage 记号接力。
//
// 唯一的例外是 `relay,node → relay`：后端的 `/api/local/leave` 支持 `targetRole:'relay'`，
// 只清 mesh 成员身份、保留中继运营状态，不需要接力。
// 纯 relay 没有网页，网页里不可能从它切出去，落在 `unsupported`。

import type { LocalLeaveTargetRole, LocalRole } from '@tmex/api-client/local/types';
import type { SetupIntent, SetupIntentRecord } from './intent';

// 纯 relay 没有网页与本机用户，不算 mesh 成员；relay,node 的 node 部分与普通 node 同路径。
export type MeshRole = Exclude<LocalRole, 'standalone' | 'relay'>;

/** 角色的展示文案 key：本机卡片的下拉与退出对话框共用一套，别各写各的。 */
export const ROLE_LABEL_KEY: Record<LocalRole, string> = {
  standalone: 'nodes.machine.roleStandalone',
  node: 'nodes.machine.roleNode',
  'hub,node': 'nodes.machine.roleHub',
  relay: 'nodes.machine.roleRelay',
  'relay,node': 'nodes.machine.roleRelayNode',
};

export type RoleTransition =
  /** 目标就是当前角色。 */
  | { kind: 'none' }
  /** standalone → 任意角色：只需展开向导。 */
  | { kind: 'setup'; intent: SetupIntentRecord }
  /** 退出：`targetRole` 决定退到 standalone 还是只退 mesh 保留中继。 */
  | { kind: 'leave'; from: MeshRole; targetRole: LocalLeaveTargetRole }
  /** 换一个角色：先退出，重启后按 `intent` 继续。 */
  | { kind: 'switch'; from: MeshRole; targetRole: LocalLeaveTargetRole; intent: SetupIntentRecord }
  /** 纯 relay 没有网页，切不出去。 */
  | { kind: 'unsupported' };

export function isMeshRole(role: LocalRole): role is MeshRole {
  return role !== 'standalone' && role !== 'relay';
}

export function isRelayRole(role: LocalRole): boolean {
  return role === 'relay' || role === 'relay,node';
}

const HUB_INTENT: Record<'node' | 'hub,node', SetupIntent> = {
  node: 'join-hub',
  'hub,node': 'become-hub',
};

/** 目标角色对应的向导路径；中继两档额外带上角色，重启后表单直接预选。 */
export function setupIntentForRole(role: Exclude<LocalRole, 'standalone'>): SetupIntentRecord {
  if (role === 'relay' || role === 'relay,node') return { path: 'become-relay', role };
  return { path: HUB_INTENT[role] };
}

export function classifyRoleChange(from: LocalRole, to: LocalRole): RoleTransition {
  if (from === to) return { kind: 'none' };
  // 纯 relay 只有 CLI，网页永远不该走到这里。
  if (from === 'relay') return { kind: 'unsupported' };
  if (from === 'standalone') {
    return { kind: 'setup', intent: setupIntentForRole(to as Exclude<LocalRole, 'standalone'>) };
  }
  // relay,node → relay：后端就地清 mesh 成员身份，中继运营状态原样留着。
  if (from === 'relay,node' && to === 'relay') {
    return { kind: 'leave', from, targetRole: 'relay' };
  }
  if (to === 'standalone') return { kind: 'leave', from, targetRole: 'standalone' };
  return { kind: 'switch', from, targetRole: 'standalone', intent: setupIntentForRole(to) };
}
