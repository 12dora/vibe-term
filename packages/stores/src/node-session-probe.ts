import {
  createNodeApiClient,
  fetchDevices,
  isNodeLoginRequiredError,
  sessionProbeTimeoutMs,
} from '@vibeterm/api-client';
import type { NodeSessionProbe } from './node-session-guard';

export { sessionProbeTimeoutMs };

/** 探测自备超时：按 api-client EWMA 放大，夹在 8s~30s。 */
export const SESSION_PROBE_TIMEOUT_MS = 8_000;

/**
 * 带会话的 HTTP 探测。超时跟着该 node 客户端观测到的延迟走，避免高 RTT 转发路径
 * 在 8 s 处误判不可达、把节点锁 10 分钟。
 */
export async function probeNodeSession(nodeId: string): Promise<NodeSessionProbe> {
  const client = createNodeApiClient(nodeId);
  try {
    await fetchDevices(client, {
      signal: AbortSignal.timeout(sessionProbeTimeoutMs(client.lastLatencyMs())),
    });
    return 'ok';
  } catch (error) {
    return isNodeLoginRequiredError(error) ? 'login-required' : 'unreachable';
  }
}
