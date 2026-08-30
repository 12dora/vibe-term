// 角色切换的分类：三种角色两两组合，只有四类结果，路由逻辑集中在这里，组件只管展示。
//
// `standalone → mesh` 走现成的 setup 向导（不动 API）；`mesh → standalone` 要退出并重启；
// `mesh → 另一个 mesh 角色` 没有直达路径——后端的 setup 端点只接受 standalone，
// 因此拆成「先退出、重启回 standalone、再开对应向导」两步，靠 sessionStorage 记号接力。

import type { LocalRole } from '@tmex/api-client/local/types';
import type { SetupIntent } from './intent';

export type MeshRole = Exclude<LocalRole, 'standalone'>;

/** 角色的展示文案 key：本机卡片的下拉与退出对话框共用一套，别各写各的。 */
export const ROLE_LABEL_KEY: Record<LocalRole, string> = {
  standalone: 'nodes.machine.roleStandalone',
  node: 'nodes.machine.roleNode',
  'hub,node': 'nodes.machine.roleHub',
};

export type RoleTransition =
  /** 目标就是当前角色。 */
  | { kind: 'none' }
  /** standalone → mesh：只需展开向导。 */
  | { kind: 'setup'; path: SetupIntent }
  /** mesh → standalone：退出 mesh。 */
  | { kind: 'leave'; from: MeshRole }
  /** mesh → 另一个 mesh 角色：先退出，重启后按 `path` 继续。 */
  | { kind: 'switch'; from: MeshRole; path: SetupIntent };

export function isMeshRole(role: LocalRole): role is MeshRole {
  return role !== 'standalone';
}

export function setupPathForRole(role: MeshRole): SetupIntent {
  return role === 'hub,node' ? 'become-hub' : 'join-hub';
}

export function classifyRoleChange(from: LocalRole, to: LocalRole): RoleTransition {
  if (from === to) return { kind: 'none' };
  if (!isMeshRole(from)) return { kind: 'setup', path: setupPathForRole(to as MeshRole) };
  if (!isMeshRole(to)) return { kind: 'leave', from };
  return { kind: 'switch', from, path: setupPathForRole(to) };
}
