import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import type { LocalAuthContext } from './local-auth';

export type RelayTargetRow = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  priority: number;
};

/**
 * `hub join` 走 r3 串时的节点侧落库：整表替换 `mesh_relays`、写入 K_log、把上级切成 relay。
 * K_meta 要等承认本节点的那条 `meta-key` 记录到达才有，这里不写。
 */
export async function persistRelayUplink(
  ctx: LocalAuthContext,
  input: {
    relays: readonly RelayTargetRow[];
    logKey: Uint8Array;
    metaKey?: { epoch: number; key: Uint8Array };
    name?: string | null;
    now?: number;
  }
): Promise<void> {
  if (input.relays.length === 0) {
    throw new Error('relay join produced no relay targets');
  }
  const store = new MeshRelayStore(ctx.db);
  const now = input.now ?? Date.now();
  await store.replaceRelays(input.relays, now);
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, input.logKey, now);
  if (input.metaKey) {
    await store.putSecret('meta', input.metaKey.epoch, input.metaKey.key, now);
  }
  store.setUplinkKind('relay');
  if (input.name) {
    store.setLocalName(input.name);
  }
}

export function readRelayUplink(ctx: LocalAuthContext): {
  kind: 'hub' | 'relay';
  relays: ReturnType<MeshRelayStore['listRelayRows']>;
  name: string | null;
} {
  const store = new MeshRelayStore(ctx.db);
  return {
    kind: store.uplinkKind(),
    relays: store.listRelayRows(),
    name: store.localName(),
  };
}
