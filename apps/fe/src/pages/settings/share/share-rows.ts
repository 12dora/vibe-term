// 进行中列表的行模型：一条分享存在它所属终端的那台节点上，行里必须带着 nodeId，
// 终止 / 查看密码 / 修改密码 / 复制链接才知道该把请求发给谁。
//
// 摊平与「哪些节点没拉回来」两件事都是纯函数，聚合查询只把结果喂进来。

import type { ShareRecord } from '@tmex/shared/share';

export interface ShareRow extends ShareRecord {
  /** 运行时 node id（entry 自身为 `self`），行内动作据此建客户端。 */
  nodeId: string;
  nodeName: string;
}

/** 行的唯一键：分享 id 只在单台节点内唯一。 */
export function shareRowKey(row: Pick<ShareRow, 'nodeId' | 'id'>): string {
  return `${row.nodeId}:${row.id}`;
}

export interface ShareRowSource {
  id: string;
  name: string;
}

export interface ShareListResult {
  data?: { active: ShareRecord[]; history: ShareRecord[] };
  isError?: boolean;
}

export function toShareRows(node: ShareRowSource, records: readonly ShareRecord[]): ShareRow[] {
  return records.map((record) => ({ ...record, nodeId: node.id, nodeName: node.name }));
}

/** 按节点顺序摊平（本机在前，由调用方的排序决定）；节点内保持服务端顺序。 */
export function flattenActiveShares(
  nodes: readonly ShareRowSource[],
  results: readonly ShareListResult[]
): ShareRow[] {
  const rows: ShareRow[] = [];
  nodes.forEach((node, index) => {
    rows.push(...toShareRows(node, results[index]?.data?.active ?? []));
  });
  return rows;
}

/** 没拉回来的节点名：单台失败只在列表上方提一行，其余节点照常出。 */
export function failedShareNodeNames(
  nodes: readonly ShareRowSource[],
  results: readonly ShareListResult[]
): string[] {
  return nodes.filter((_, index) => results[index]?.isError === true).map((node) => node.name);
}
