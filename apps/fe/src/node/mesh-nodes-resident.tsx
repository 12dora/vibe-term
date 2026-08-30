// mesh 成员列表与 NODE_EVENT 的常驻所有者。
//
// 挂在外壳根上：侧边栏切到智能体 / 文件标签时设备区会整块卸载，若拉取与事件订阅只挂在
// 设备区，离线态就会停在卸载那一刻的快照上（远端 node 掉线后界面仍显示在线）。
// standalone 下不发任何 `/api/mesh/*` 请求。

import { useMeshNodes, useSharedAuthMode } from './mesh-nodes';

export function MeshNodesResident() {
  const { meshEnabled } = useSharedAuthMode();
  useMeshNodes({ enabled: meshEnabled });
  return null;
}
