import { getMeshAgentBridge } from '../mesh/mesh-agent-bridge';
import { meshInternalExportPath } from './internal-routes';

const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * 尽力而为地清掉 B 上的放行行：A 侧的行照删，这里失败只记日志并把结果回给界面，
 * 由使用者自己去 B 上收尾。
 */
export async function requestPeerExportRemoval(nodeId: string, mapId: string): Promise<boolean> {
  const bridge = getMeshAgentBridge();
  if (!bridge) return false;
  try {
    const res = await bridge.forwardInternalHttp(
      nodeId,
      meshInternalExportPath(mapId),
      {},
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    );
    if (!res.ok) {
      console.warn(`[portmap] target node ${nodeId} refused export cleanup: ${res.status}`);
      return false;
    }
    const body = (await res.json().catch(() => null)) as { removed?: unknown } | null;
    return body?.removed === true;
  } catch (err) {
    console.warn('[portmap] failed to clean up the export on the target node', err);
    return false;
  }
}
