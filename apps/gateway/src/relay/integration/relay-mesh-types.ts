import type { VibeTermRoles } from '@vibeterm/shared';
import type { RootKey } from '@vibeterm/shared/auth';
import type { RelayEnvelope } from '@vibeterm/shared/relay';
import type { MeshRelayStore } from '../../auth/mesh-relay-store';
import type { AuthDb } from '../../auth/types';
import type { UserKeyService } from '../../auth/user-key-service';
import type { UserStore } from '../../auth/user-store';
import type { CreateMeshRuntimeOptions, MeshRuntime } from '../../mesh/mesh-runtime';
import type { RelayUplinkClient } from '../../mesh/relay-uplink-client';
import { waitUntil } from '../../mesh/test-support';
import type { MeshScheduler } from '../../mesh/types';
import type { UplinkWsFactory } from '../../mesh/uplink-client';
import type { GatewayRuntime } from '../../runtime';
import {
  RELAY_TEST_PUBLIC_URL,
  type RelayHarness,
  type RelayHarnessOptions,
} from '../relay-test-harness';

export { RELAY_TEST_PUBLIC_URL, waitUntil };

export const RELAY_TEST_PUBLIC_URL_2 = 'https://relay-b.example';

/** `waitUntil` 只认同步断言，异步探针（要打 HTTP）走这个。 */
export async function waitUntilAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
  stepMs = 10
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntilAsync timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

type ReportedPeer = { version: string | null; name: string };

/**
 * 等到观察节点的 `peer_cache` 记下对端版本。
 * uplink `online` 只表示认证完成；版本要等 `relay.status` 进入中继名单、观察方解开状态块后才落库。
 * 对端断开后名单不再附带状态块，漏掉的版本补不回来。
 */
export async function waitForReportedPeerVersion(
  observer: { userStore: { getPeer(nodeId: string): ReportedPeer | null } },
  peerNodeId: string,
  timeoutMs = 8_000
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const peer = observer.userStore.getPeer(peerNodeId);
    if (peer?.version) return peer.version;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `peer ${peerNodeId} version was not reported within ${timeoutMs}ms (cached=${peer != null}, name=${peer?.name ?? 'null'}, version=${peer?.version ?? 'null'})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const NODE_PASSWORD = 'relay-integration-pass';
export const NODE_ROLES: VibeTermRoles = { node: true, relay: false };

/**
 * 池子在没有可用上级时会立刻重试；`FastScheduler` 的 sleep 直接 resolve 会把测试拖成热循环。
 * 这里给一个真实但很短的退避。
 */
export class ShortBackoffScheduler implements MeshScheduler {
  now(): number {
    return Date.now();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const id = setInterval(fn, ms);
    return { clear: () => clearInterval(id) };
  }
}

export type RelayKeyLogPage = Array<{ seq: number | string; blob: RelayEnvelope }>;

export type RelayMeshNode = {
  label: string;
  mesh: MeshRuntime;
  db: AuthDb;
  userStore: UserStore;
  keys: UserKeyService;
  relayStore: MeshRelayStore;
  nodeId: string;
  cookie: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  relayClient(): RelayUplinkClient | null;
  metaEpochs(): number[];
  close(): Promise<void>;
};

export type RelayTenant = {
  label: string;
  userId: string;
  rootKey: RootKey;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  owner: RelayMeshNode;
  nodes: RelayMeshNode[];
  tenantId(): string;
  enrollRaw(opts?: { password?: string }): Promise<Response>;
  enroll(opts?: { password?: string }): Promise<void>;
  joinNode(label: string, bootOpts?: MeshBootOverrides): Promise<RelayMeshNode>;
  admit(node: RelayMeshNode): Promise<void>;
  revoke(node: RelayMeshNode): Promise<void>;
  rotateMetaKey(exclude?: string[]): Promise<void>;
  submitPrepared(res: Response, type: 'set-relays' | 'meta-key'): Promise<void>;
  submitRecord(
    node: RelayMeshNode,
    type: 'set-relays' | 'meta-key' | 'admit-node' | 'revoke-node' | 'rotate-root-keep',
    payload: Uint8Array
  ): Promise<Response>;
  /** 旧根签一条 `rotate-root-keep` 并等中继跟上；返回新的根钥。 */
  rotateRoot(): Promise<RootKey>;
};

export type RelayMeshHarness = {
  relay: RelayHarness;
  wsFactory: UplinkWsFactory;
  createTenant(label: string, opts?: TenantOptions): Promise<RelayTenant>;
  bootNode(label: string, boot: NodeBoot): Promise<RelayMeshNode>;
  addRelay(publicUrl: string, opts?: RelayHarnessOptions): Promise<RelayHarness>;
  stop(): Promise<void>;
};

export type MeshBootOverrides = {
  roles?: VibeTermRoles;
  wsFactory?: UplinkWsFactory;
  linkFactory?: CreateMeshRuntimeOptions['linkFactory'];
  linkFactoryFor?: (nodeId: string) => CreateMeshRuntimeOptions['linkFactory'];
  loadNative?: CreateMeshRuntimeOptions['loadNative'];
  startPeerServer?: boolean;
  peerPort?: number;
  stunServers?: string[];
  pingIntervalMs?: number;
  networkInterfaces?: CreateMeshRuntimeOptions['networkInterfaces'];
  gateway?: GatewayRuntime;
  gatewayFactory?: (db: AuthDb, label: string) => GatewayRuntime;
  omitUserId?: boolean;
};

export type TenantOptions = MeshBootOverrides & {
  password?: string;
};

export type NodeBoot = MeshBootOverrides & {
  userId: string;
  rootKey: RootKey;
  db?: AuthDb;
  close?: () => void;
};

const RELAY_HOST = new URL(RELAY_TEST_PUBLIC_URL).host;
