import type { MeshNode } from '@vibeterm/shared';

/** Mesh 节点行以上游 `@vibeterm/shared` `contracts/mesh-node` 为准。 */
export { DIRECT_FAILURE_CODES } from '@vibeterm/shared';
export type {
  DirectFailureCode,
  DirectFailureDcParams,
  DirectFailureWsParams,
  MeshNode,
  MeshNodeDcBreaker,
  MeshNodeDirectFailure,
  MeshNodeReach,
  MeshNodeTransport,
  MeshPortReach,
} from '@vibeterm/shared';

export interface MeshNodesResponse {
  nodes: MeshNode[];
  /**
   * 本机见过的最高成员列表版本（`node.list` / `relay.list`）；一次都没应用过为 0。
   * 旧网关不下发。
   */
  listVersion?: number;
  /**
   * 已 admit、但状态块还没解开因而名字 / inventory 仍为空的成员数。大于 0 表示成员列表
   * 还在同步中，界面应显示加载态而不是「只有本机」。旧网关不下发。
   */
  pendingMembers?: number;
  /**
   * 上一条的成员 id（`pendingMembers === pendingMemberIds.length`）。已经出现在 `nodes`
   * 里的那几行要就地画成占位，只有不在列表里的才另补占位分组。旧网关不下发。
   */
  pendingMemberIds?: string[];
}

/** `GET /api/auth/nodes` 的单行（**公开**，不含公钥 / inventory）。登录页在登录前用它。 */
export interface PublicNode {
  id: string;
  name: string;
  online: boolean;
}

export interface PublicNodesResponse {
  nodes: PublicNode[];
}
