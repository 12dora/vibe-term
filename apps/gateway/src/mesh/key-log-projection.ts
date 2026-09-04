import { decodeRenameNodePayload, nodeIdToHex, normalizeNodeName } from '@tmex/shared/auth';
import type { UserKeyService } from '../auth';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
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
};

export function bindKeyLogProjection(
  d: KeyLogProjectionDeps
): NonNullable<UserKeyService['onApplied']> {
  return (_userId, step) => {
    applyKeyLogHubRuntime(d.hubStore, step.record, {
      selfId: d.selfId,
      now: Date.now(),
      onRetireSelf: () => d.hub?.setMode('standby'),
    });
    d.relay.notifyIfRelayRecord(step.record.type);
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
