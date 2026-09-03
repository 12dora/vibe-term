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
  userKeyLog,
  userKeys,
  users,
} from '../db/schema';
import type { AuthDb } from './types';

export class MeshMembershipStore {
  constructor(private readonly db: AuthDb) {}

  clearAll(): void {
    this.db.transaction((tx) => {
      tx.delete(userKeyLog).run();
      tx.delete(userKeys).run();
      tx.delete(nodeSessions).run();
      tx.delete(nodeCerts).run();
      tx.delete(nodes).run();
      tx.delete(enrollmentTokens).run();
      tx.delete(peerCache).run();
      tx.delete(hubTrust).run();
      tx.delete(meshHubs).run();
      // 中继租户令牌与 K_log / K_meta 不能在退出后留在盘上
      tx.delete(meshRelays).run();
      tx.delete(meshSecrets).run();
      tx.delete(nodeIdentity).run();
      tx.delete(users).run();
    });
  }
}
