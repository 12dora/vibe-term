import {
  enrollmentTokens,
  hubTrust,
  meshHubs,
  meshRelays,
  meshSecrets,
  nodeCerts,
  nodeIdentity,
  nodeSessions,
  nodes,
  peerCache,
  relayConfig,
  relayEnrollments,
  relayKeyLog,
  relayNodes,
  relayTenants,
  userKeyLog,
  userKeys,
  users,
} from '../db/schema';
import type { AuthDb } from './types';

function wipeMeshMembership(db: AuthDb): void {
  db.delete(userKeyLog).run();
  db.delete(userKeys).run();
  db.delete(nodeSessions).run();
  db.delete(nodeCerts).run();
  db.delete(nodes).run();
  db.delete(enrollmentTokens).run();
  db.delete(peerCache).run();
  db.delete(hubTrust).run();
  db.delete(meshHubs).run();
  // 中继租户令牌与 K_log / K_meta 不能在退出后留在盘上
  db.delete(meshRelays).run();
  db.delete(meshSecrets).run();
  db.delete(nodeIdentity).run();
  db.delete(users).run();
}

function wipeRelayOperatorState(db: AuthDb): void {
  db.delete(relayKeyLog).run();
  db.delete(relayEnrollments).run();
  db.delete(relayNodes).run();
  db.delete(relayTenants).run();
  db.delete(relayConfig).run();
}

export class MeshMembershipStore {
  constructor(private readonly db: AuthDb) {}

  clearMeshMembership(): void {
    this.db.transaction((tx) => {
      wipeMeshMembership(tx);
    });
  }

  clearRelayOperatorState(): void {
    this.db.transaction((tx) => {
      wipeRelayOperatorState(tx);
    });
  }

  clearAll(): void {
    this.db.transaction((tx) => {
      wipeMeshMembership(tx);
      wipeRelayOperatorState(tx);
    });
  }
}
