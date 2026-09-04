import { eq } from 'drizzle-orm';
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
import { toBuffer } from './binary';
import type { AuthDb } from './types';

export type ClearMeshMembershipOptions = {
  /** 与即将离开的本机用户根公钥匹配的中继租户；同事务删除，级联清 nodes / enrollments / key_log。 */
  removeRelayTenantRootPublicKey?: Uint8Array;
};

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

function wipeMatchingRelayTenant(db: AuthDb, rootPublicKey: Uint8Array): void {
  db.delete(relayTenants)
    .where(eq(relayTenants.rootPublicKey, toBuffer(rootPublicKey)))
    .run();
}

export class MeshMembershipStore {
  constructor(private readonly db: AuthDb) {}

  clearMeshMembership(options?: ClearMeshMembershipOptions): void {
    this.db.transaction((tx) => {
      wipeMeshMembership(tx);
      const root = options?.removeRelayTenantRootPublicKey;
      if (root && root.byteLength > 0) wipeMatchingRelayTenant(tx, root);
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
