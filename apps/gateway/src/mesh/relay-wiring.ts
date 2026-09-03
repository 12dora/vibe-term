import type { KeyLogType } from '@tmex/shared/auth';
import type { HubMode } from '@tmex/shared/uplink';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { AuthDb } from '../auth/types';
import type { UserKeyService } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import type { MeshRoles } from './mesh-deps';
import { stamp } from './mesh-log';
import { RelayRoutes } from './relay-routes';
import { RelaySecrets } from './relay-secrets';
import { RelayUplinkClient } from './relay-uplink-client';
import { probeRelayHealth } from './relay-uplink-http';
import { UplinkClient } from './uplink-client';
import {
  type UplinkCandidate,
  type UplinkPool,
  type UplinkPoolOptions,
  defaultProbeHealthz,
} from './uplink-pool';

const RELAY_RECORD_TYPES: ReadonlySet<string> = new Set(['set-relays', 'meta-key']);

export type RelayWiring = {
  secrets: RelaySecrets;
  notifyIfRelayRecord(type: KeyLogType): void;
  /** 启动时的一次落库：只写库、不重建连接循环（池还没起）。 */
  reconcileQuietly(): Promise<void>;
};

type RelayBinding = { uplink: UplinkPool; hubStore: Pick<MeshHubStore, 'replaceAll'> };

const RELAY_BINDINGS = new WeakMap<RelayWiring, RelayBinding>();

export function createRelayWiring(input: {
  db: AuthDb;
  identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array };
  userIdOf: () => string;
}): RelayWiring {
  const secrets = new RelaySecrets(input);
  const wiring: RelayWiring = {
    secrets,
    notifyIfRelayRecord(type) {
      if (RELAY_RECORD_TYPES.has(type)) void runReconcile(wiring, true);
    },
    reconcileQuietly: () => runReconcile(wiring, false),
  };
  return wiring;
}

async function runReconcile(wiring: RelayWiring, allowRestart: boolean): Promise<void> {
  const bound = RELAY_BINDINGS.get(wiring);
  try {
    const result = await wiring.secrets.reconcile();
    // 切到中继后不再保留 hub 集合，`/api/mesh/hubs` 自然返回空表
    if (result.kind === 'relay') bound?.hubStore.replaceAll([], Date.now());
    if (allowRestart && result.targetsChanged && bound) {
      await reconfigureUplinkPool(bound.uplink);
    }
  } catch (err) {
    console.error(stamp('[relay] reconcile failed'), err);
  }
}

/** 停掉当前会话再按新的 `candidates()` / `createClient()` 重开；池对象本身不换。 */
export async function reconfigureUplinkPool(uplink: UplinkPool): Promise<void> {
  await uplink.stop();
  uplink.start();
}

/** mesh-runtime 暴露的手动重建入口：先落库再重开连接循环。 */
export async function reconfigureRelayUplink(
  wiring: RelayWiring,
  uplink: UplinkPool
): Promise<void> {
  await wiring.reconcileQuietly();
  await reconfigureUplinkPool(uplink);
}

export function bindRelayReconcile(
  wiring: RelayWiring,
  uplink: UplinkPool,
  hubStore: Pick<MeshHubStore, 'replaceAll'>
): void {
  RELAY_BINDINGS.set(wiring, { uplink, hubStore });
}

export type RelayUplinkOverrides = {
  relayMode(): boolean;
  candidates(): UplinkCandidate[];
  createClient: NonNullable<UplinkPoolOptions['createClient']>;
  probeHealthz: NonNullable<UplinkPoolOptions['probeHealthz']>;
};

/** 中继模式下替换池子的候选来源、客户端构造与健康探测。 */
export function relayUplinkOverrides(
  wiring: RelayWiring,
  opts: { nameProvider: () => string }
): RelayUplinkOverrides {
  const relayMode = () => wiring.secrets.uplinkKind() === 'relay';
  return {
    relayMode,
    candidates: () =>
      wiring.secrets.relayRows().map((row) => ({
        hubNodeId: null,
        publicUrl: row.url,
        mode: 'active' as HubMode,
        writerEpoch: 0,
        priority: row.priority,
        caFingerprint: null,
      })),
    createClient: (o) =>
      relayMode()
        ? new RelayUplinkClient({
            hubUrl: o.hubUrl,
            identity: o.identity,
            userId: o.userId,
            keyLogApplier: o.keyLogApplier,
            userStore: o.userStore,
            secrets: wiring.secrets,
            statusProvider: o.statusProvider,
            nameProvider: opts.nameProvider,
            ...(o.onNodeList ? { onNodeList: o.onNodeList } : {}),
            ...(o.onRtcSignal ? { onRtcSignal: o.onRtcSignal } : {}),
            ...(o.onEnrollRedeemed ? { onEnrollRedeemed: o.onEnrollRedeemed } : {}),
            ...(o.wsFactory ? { wsFactory: o.wsFactory } : {}),
            tlsCa: o.tlsCa ?? null,
            ...(o.scheduler ? { scheduler: o.scheduler } : {}),
            ...(o.pingIntervalMs !== undefined ? { pingIntervalMs: o.pingIntervalMs } : {}),
            onKicked: () => markRelayKicked(wiring, o.hubUrl),
          })
        : new UplinkClient(o),
    probeHealthz: (publicUrl, tlsCa, timeoutMs) =>
      relayMode()
        ? probeRelayHealth(publicUrl, tlsCa, timeoutMs)
        : defaultProbeHealthz(publicUrl, tlsCa, timeoutMs),
  };
}

function markRelayKicked(wiring: RelayWiring, url: string): void {
  try {
    wiring.secrets.store.markKicked(url, true);
  } catch {
    // 行可能刚被新的 set-relays 换掉
  }
}

export function createRelayRoutes(input: {
  wiring: RelayWiring;
  roles: MeshRoles;
  nodeSessionStore: NodeSessionStore;
  trustProxy?: boolean;
  nodeId: string;
  userStore: UserStore;
  keyLogService: UserKeyService;
  uplink: UplinkPool;
}): RelayRoutes {
  return new RelayRoutes({
    session: {
      roles: input.roles,
      nodeSessionStore: input.nodeSessionStore,
      ...(input.trustProxy !== undefined ? { trustProxy: input.trustProxy } : {}),
    },
    nodeId: input.nodeId,
    userStore: input.userStore,
    keyLogService: input.keyLogService,
    secrets: input.wiring.secrets,
    uplink: {
      liveClient: () => input.uplink.liveClient(),
      attachedHub: () => input.uplink.attachedHub(),
      reconfigure: () => reconfigureUplinkPool(input.uplink),
    },
  });
}
