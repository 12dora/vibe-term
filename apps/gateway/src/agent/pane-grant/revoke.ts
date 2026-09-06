import { deletePaneGrantsForNode } from './store';

/** 节点吊销钩子：库还没就绪（装配早于迁移）时静默跳过，不影响吊销本身。 */
export function dropPaneGrantsOfNode(nodeId: string): void {
  try {
    deletePaneGrantsForNode(nodeId);
  } catch (error) {
    console.warn(`[agent/pane-grant] drop grants for revoked node ${nodeId} failed:`, error);
  }
}
