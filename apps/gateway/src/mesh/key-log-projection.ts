import {
  type KeyLogEffect,
  decodeRenameNodePayload,
  decodeRevokeNodePayload,
  nodeIdToHex,
  normalizeNodeName,
} from '@vibeterm/shared/auth';
import type { UserKeyService } from '../auth';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
import { meshForwardChannel } from '../events/channels/mesh-forward';
import type { HubRuntime } from '../hub';
import { applyKeyLogHubRuntime } from '../hub/hub-authorization';
import { type NodeListApplyDeps, emitRenameNodeEvent } from './node-list-apply';
import type { RelayWiring } from './relay-wiring';

export type KeyLogProjectionDeps = {
  hubStore: MeshHubStore;
  hub: HubRuntime | null;
  relay: RelayWiring;
  selfId: string;
  userStore: UserStore;
  state: NodeListApplyDeps['state'];
  peerHolder: NodeListApplyDeps['peerHolder'];
  emitListNodeEvent: NodeListApplyDeps['emitListNodeEvent'];
  onLocalNodeName?: (name: string) => void;
  userIdOf: () => string;
  /** 吊销落库后就地断链并广播；key log 同步（含中继模式）走的也是这条路径。 */
  onNodeRevoked: (nodeId: string) => void;
  /**
   * 本条记录的会话效果（撤销全部会话 / 按凭证撤销 / 按入口撤销 / 清 peer 缓存）。
   * 本地追加路由、uplink 同步、中继同步、peer 追赶全都汇到 `onApplied`，
   * 撤销的即时性只能从这个唯一收敛点升上去，不能只挂在本地路由上。
   */
  onKeyLogEffects?: (userId: string, effects: KeyLogEffect[]) => void;
};

export function bindKeyLogProjection(
  d: KeyLogProjectionDeps
): NonNullable<UserKeyService['onApplied']> {
  return (userId, step) => {
    d.onKeyLogEffects?.(userId, step.effects);
    applyKeyLogHubRuntime(d.hubStore, step.record, {
      selfId: d.selfId,
      now: Date.now(),
      onRetireSelf: () => d.hub?.setMode('standby'),
    });
    d.relay.notifyIfRelayRecord(step.record.type);
    // 汇聚声明变了：撤销掉的汇聚机队列与在途投递立刻收掉，别等下一次重试才发现。
    if (step.record.type === 'notification-sink') {
      meshForwardChannel.pruneUnauthorizedSinks();
      return;
    }
    if (step.record.type === 'revoke-node') {
      applyRevokeNode(d, step.record.payload);
      return;
    }
    if (step.record.type !== 'rename-node') return;
    let name: string | null = null;
    let nodeId: string;
    try {
      const payload = decodeRenameNodePayload(step.record.payload);
      name = normalizeNodeName(payload.name);
      nodeId = nodeIdToHex(payload.node_id);
    } catch {
      return;
    }
    if (!name) return;
    d.hub?.registry.updateMeta(nodeId, { name }, Date.now());
    emitRenameNodeEvent(
      {
        state: d.state,
        identity: { nodeIdHex: d.selfId },
        hubStore: d.hubStore,
        scheduler: { now: () => Date.now() },
        userIdOf: d.userIdOf,
        userStore: d.userStore,
        peerHolder: d.peerHolder,
        emitListNodeEvent: d.emitListNodeEvent,
        opts: { onLocalNodeName: d.onLocalNodeName },
      },
      nodeId,
      name
    );
  };
}

function applyRevokeNode(d: KeyLogProjectionDeps, payload: Uint8Array): void {
  let nodeId: string;
  try {
    nodeId = nodeIdToHex(decodeRevokeNodePayload(payload).node_id);
  } catch {
    return;
  }
  if (nodeId === d.selfId) return;
  d.onNodeRevoked(nodeId);
}
