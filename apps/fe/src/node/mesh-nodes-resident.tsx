// mesh 成员列表与 NODE_EVENT 的常驻所有者。
//
// 挂在外壳根上：侧边栏切到智能体 / 文件标签时设备区会整块卸载，若拉取与事件订阅只挂在
// 设备区，离线态就会停在卸载那一刻的快照上（远端 node 掉线后界面仍显示在线）。
// standalone 下不发任何 `/api/mesh/*` 请求。
//
// 它也是**唯一**的轮询方（`owner`）：其余 `useMeshNodes()` 消费方只订阅这份 store，
// 否则侧边栏、设备页各装一个定时器，稳态就是好几轮重复的 `/api/mesh/nodes`。
//
// 稳态只留 5 分钟的兜底轮询（`MESH_NODES_POLL_MS`）：实时更新由 `/mesh/ws` 的 NODE_EVENT
// 推送，成员变动、事件断流与回到前台则各自触发即时补拉（见 `mesh-nodes.ts` 的轮询回路）。

import { useMeshNodes, useSharedAuthMode } from './mesh-nodes';

export function MeshNodesResident() {
  const { meshEnabled } = useSharedAuthMode();
  useMeshNodes({ enabled: meshEnabled, owner: true });
  return null;
}
