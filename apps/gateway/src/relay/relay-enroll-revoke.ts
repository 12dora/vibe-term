import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayUplinkServer } from './relay-uplink-server';

/** `force_rotate` 换发里随带的已吊销节点上限。 */
export const RELAY_ENROLL_REVOKED_MAX = 256;

const NODE_ID_HEX = /^[0-9a-f]{32}$/;

/** `revoked_node_ids`：缺省为空；不是 hex node_id 数组或超过上限返回 null（调用方回 400）。 */
export function parseEnrollRevokedNodeIds(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > RELAY_ENROLL_REVOKED_MAX) return null;
  if (!raw.every((id) => typeof id === 'string' && NODE_ID_HEX.test(id))) return null;
  return [...new Set(raw as string[])];
}

/**
 * 根证明过的 `force_rotate` 换发带来的吊销：每个 node_id 记 `revoked`（中继没见过的也插一行终态），
 * 断开它们的在线链路。令牌收紧由换发本身完成。
 */
export function applyEnrollRevocations(
  deps: { tenants: RelayTenantStore; uplink: RelayUplinkServer; now: () => number },
  tenantId: string,
  nodeIds: readonly string[]
): void {
  if (nodeIds.length === 0) return;
  const now = deps.now();
  for (const nodeId of nodeIds) {
    deps.tenants.markNodeRevoked(tenantId, nodeId, now);
    deps.uplink.disconnectNode(tenantId, nodeId, 'revoked');
  }
  deps.uplink.scheduleList(tenantId);
}
