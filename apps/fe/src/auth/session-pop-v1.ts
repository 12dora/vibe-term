// PoP 记录 v1（单把钥 + nodeId→过期时刻）升级成按 node 绑定的 v2。懒加载，只在读到旧记录时用一次。

import { PERSISTED_POP_VERSION, type PersistedPopState, isPopKey } from './session-key-persistence';
import { popKeyId } from './session-pop-login';

/** 那把钥绑到它名下的所有 node；记录结构不对返回 null。 */
export function upgradePopV1(old: Record<string, unknown>): PersistedPopState | null {
  const { privateKey, sessPk, nodes } = old as {
    privateKey: unknown;
    sessPk: unknown;
    nodes: Record<string, number>;
  };
  if (!isPopKey(privateKey) || !(sessPk instanceof Uint8Array)) return null;
  const pk = popKeyId(sessPk);
  return {
    version: PERSISTED_POP_VERSION,
    keys: { [pk]: { privateKey, sessPk } },
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([nodeId, expiresAt]) => [nodeId, { pk, expiresAt }])
    ),
  };
}
