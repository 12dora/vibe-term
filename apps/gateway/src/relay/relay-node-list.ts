import {
  RELAY_CTL_MAX_BYTES,
  RELAY_CTL_MAX_NODES,
  type RelayCtlMessage,
  type RelayListNode,
  type RelayRtcConfig,
  encodeRelayCtl,
  relaySeqToWire,
} from '@tmex/shared/relay';
import type { RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';

export type RelayListDeps = {
  tenants: RelayTenantStore;
  registry: RelayRegistry;
  rtc: () => RelayRtcConfig;
  nextVersion: () => number;
};

export function buildRelayList(
  deps: RelayListDeps,
  tenantId: string,
  withBlobs: boolean
): RelayCtlMessage {
  // 先滤掉 revoked 再截断：否则一堆吊销行会把还活着的节点挤出 256 条的窗口
  const rows = deps.tenants
    .listNodes(tenantId)
    .filter((row) => row.status !== 'revoked')
    .slice(0, RELAY_CTL_MAX_NODES);
  const nodes: RelayListNode[] = rows.map((row) => {
    const live = deps.registry.get(tenantId, row.nodeId);
    const blob = withBlobs ? live?.statusBlob : null;
    return {
      id: row.nodeId,
      online: Boolean(live),
      status: row.status,
      ...(blob ? { epoch: live?.statusEpoch ?? 0, blob } : {}),
    };
  });
  return {
    t: 'relay.list',
    version: deps.nextVersion(),
    nodes,
    rtc: deps.rtc(),
    key_log_head_seq: relaySeqToWire(deps.tenants.get(tenantId)?.keyLogHeadSeq ?? 0n),
  };
}

/** 状态块可能把帧撑爆 64 KiB；那时退化成不带 blob 的清单，至少让成员关系同步。 */
export function encodeRelayList(deps: RelayListDeps, tenantId: string): Uint8Array | null {
  try {
    const bytes = encodeRelayCtl(buildRelayList(deps, tenantId, true));
    if (bytes.byteLength <= RELAY_CTL_MAX_BYTES) return bytes;
  } catch {
    // 落到无 blob 版本
  }
  try {
    return encodeRelayCtl(buildRelayList(deps, tenantId, false));
  } catch {
    console.warn(`[relay] failed to encode node list tenant=${tenantId}`);
    return null;
  }
}
