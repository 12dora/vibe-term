import os from 'node:os';
import type { LinkSession } from '@tmex/shared/link';
import {
  type HubAdvertisement,
  type HubEndpointInfo,
  type HubMode,
  UPLINK_CTL_MAX_HUBS,
} from '@tmex/shared/uplink';
import { type MeshHubRecord, type MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { parseJson, projectNode, upsertById } from '../mesh/node-list-projection';
import { patchNode } from './node-persistence';
import type { NodeRegistry } from './node-registry';
import type { HubKeyLogSource, HubRuntimeConfig } from './types';
import {
  type NodeListMessage,
  type UplinkCtlMessage,
  bytesToB64url,
  encodeUplinkCtl,
  seqToWire,
} from './uplink-protocol';
import type { LiveConnection, UplinkServerState } from './uplink-server-state';

export type UplinkNodeListDeps = {
  hubNodeId: () => string | undefined;
  isWriter: () => boolean;
  isAuthorizedHub: (nodeId: string, userId?: string | null) => boolean;
  authorizedHubRecords: () => MeshHubRecord[];
  sendBytes: (link: LinkSession, bytes: Uint8Array) => void;
  assertLiveCert: (live: LiveConnection) => boolean;
  applyAuthorizedHubAdvertisement: (
    hubNodeId: string,
    ad: HubAdvertisement,
    source?: 'uplink' | 'peer-status'
  ) => void;
  sendTokenSnapshotOnce: (live: LiveConnection) => void;
};

export type UplinkNodeListOptions = {
  state: UplinkServerState;
  db: AuthDb;
  userStore: UserStore;
  registry: NodeRegistry;
  meshHubs: MeshHubStore;
  keyLogSource: HubKeyLogSource;
  config: HubRuntimeConfig;
  now: () => number;
  deps: UplinkNodeListDeps;
};

/** node.list 的投影、去重广播，以及 node.status 上报的落库。 */
export class UplinkNodeList {
  private readonly state: UplinkServerState;
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly meshHubs: MeshHubStore;
  private readonly keyLogSource: HubKeyLogSource;
  private readonly config: HubRuntimeConfig;
  private readonly now: () => number;
  private readonly deps: UplinkNodeListDeps;
  private listVersion = 0;
  private readonly nodeListLatestGen = new Map<string, number>();
  private readonly nodeListInflight = new Map<string, Promise<'sent' | 'unchanged' | 'failed'>>();

  constructor(opts: UplinkNodeListOptions) {
    this.state = opts.state;
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.meshHubs = opts.meshHubs;
    this.keyLogSource = opts.keyLogSource;
    this.config = opts.config;
    this.now = opts.now;
    this.deps = opts.deps;
  }

  broadcastAllNodeLists(): void {
    const seen = new Set<string>();
    for (const entry of this.registry.listAuthenticated()) {
      if (seen.has(entry.userId)) continue;
      seen.add(entry.userId);
      void this.broadcastNodeList(entry.userId);
    }
  }

  async broadcastNodeList(userId: string): Promise<'sent' | 'unchanged' | 'failed'> {
    if (this.state.stopped) return 'failed';
    this.nodeListLatestGen.set(userId, (this.nodeListLatestGen.get(userId) ?? 0) + 1);
    const existing = this.nodeListInflight.get(userId);
    if (existing) return existing;
    const run = this.pumpNodeListBroadcast(userId);
    this.nodeListInflight.set(userId, run);
    return run;
  }

  private async pumpNodeListBroadcast(userId: string): Promise<'sent' | 'unchanged' | 'failed'> {
    try {
      let result: 'sent' | 'unchanged' | 'failed' = 'unchanged';
      while (!this.state.stopped) {
        const gen = this.nodeListLatestGen.get(userId) ?? 0;
        result = await this.publishNodeList(userId, gen);
        if (this.state.stopped) {
          this.nodeListInflight.delete(userId);
          return 'failed';
        }
        // 必须与 gen 比较同一同步段内摘掉 inflight，await 后再删会丢掉其间到达的 trigger
        if (gen === (this.nodeListLatestGen.get(userId) ?? 0)) {
          this.nodeListInflight.delete(userId);
          return result;
        }
      }
      this.nodeListInflight.delete(userId);
      return 'failed';
    } catch (err) {
      this.nodeListInflight.delete(userId);
      throw err;
    }
  }

  private async publishNodeList(
    userId: string,
    gen: number
  ): Promise<'sent' | 'unchanged' | 'failed'> {
    if (this.registry.listForBroadcast(userId).length === 0) {
      if (gen !== (this.nodeListLatestGen.get(userId) ?? 0)) return 'unchanged';
      this.state.lastNodeListFp.delete(userId);
      this.state.lastNodeListSent.delete(userId);
      return 'unchanged';
    }
    try {
      const msg = await this.buildNodeList(userId);
      if (this.state.stopped) return 'failed';
      if (gen !== (this.nodeListLatestGen.get(userId) ?? 0)) return 'unchanged';
      const fingerprint = nodeListFingerprint(msg);
      const prev = this.state.lastNodeListFp.get(userId);
      if (prev === fingerprint) return 'unchanged';
      this.listVersion += 1;
      msg.version = this.listVersion;
      const bytes = encodeUplinkCtl(msg);
      this.state.lastNodeListFp.set(userId, fingerprint);
      this.state.lastNodeListSent.set(userId, bytes);
      for (const entry of this.registry.listForBroadcast(userId)) {
        this.deps.sendBytes(entry.link, bytes);
      }
      return 'sent';
    } catch {
      return 'failed';
    }
  }

  private async buildNodeList(userId: string): Promise<NodeListMessage> {
    const version = Math.max(1, this.listVersion);
    const head = await this.keyLogSource.head(userId);
    this.state.attachments.expire();
    const online = new Map(
      this.registry.listForBroadcast(userId).map((n) => [n.nodeId, n] as const)
    );
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === userId && n.status === 'enrolled')
      .map((n) => {
        const live = online.get(n.id);
        const attached = this.state.attachments.attachedHubId(n.id);
        return projectNode(
          n.id,
          n.name,
          Boolean(live) || Boolean(attached),
          {
            endpoints: parseJson(n.endpointsJson, []),
            inventory: parseJson(n.inventoryJson, {}),
            directCapable: n.directCapable,
            version: n.version ?? '',
          },
          live?.meta,
          attached
        );
      });
    const hubNodeId =
      this.deps.hubNodeId() ?? this.config.nodeId ?? this.userStore.getHubMeta()?.nodeId;
    const hubName = hubNodeId ? this.nodeDisplayName(hubNodeId) : null;
    if (hubNodeId) {
      this.userStore.upsertHubMeta({
        nodeId: hubNodeId,
        publicUrl: this.config.publicUrl,
        now: this.now(),
        listVersion: version,
      });
      const existing = nodes.find((n) => n.id === hubNodeId);
      upsertById(
        nodes,
        projectNode(
          hubNodeId,
          hubName ?? hubNodeId,
          true,
          {
            endpoints: existing?.endpoints ?? [],
            inventory: existing?.inventory ?? {},
            directCapable: existing?.direct_capable ?? false,
            version: existing?.version ?? '',
          },
          online.get(hubNodeId)?.meta,
          this.state.attachments.attachedHubId(hubNodeId) ?? hubNodeId
        )
      );
    }
    const hubRecords = this.deps.authorizedHubRecords();
    const ownId = this.deps.hubNodeId();
    const hubs = hubRecords
      .slice(0, UPLINK_CTL_MAX_HUBS)
      .map((row) => this.toHubEndpoint(row, ownId));
    const writerId = pickWriterHub(hubRecords);
    const writer = writerId ? this.meshHubs.get(writerId) : null;
    const writerName = writer?.name?.trim() || null;
    const legacyHub = writer
      ? {
          nodeId: writer.hubNodeId,
          publicUrl: writer.publicUrl,
          ...(writerName ? { name: writerName } : {}),
        }
      : hubNodeId
        ? {
            nodeId: hubNodeId,
            publicUrl: this.config.publicUrl,
            ...(hubName ? { name: hubName } : {}),
          }
        : undefined;
    return {
      t: 'node.list',
      version,
      key_log_head: { seq: seqToWire(head.seq), hash: bytesToB64url(head.hash) },
      rtc: { stun: this.config.stun, turn: this.config.turn ?? null },
      nodes,
      ...(legacyHub ? { hub: legacyHub } : {}),
      ...(hubs.length > 0 ? { hubs } : {}),
      ...(writerId ? { writerHubId: writerId, writerEpoch: writer?.writerEpoch } : {}),
    };
  }

  async handleNodeStatus(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'node.status' }>
  ): Promise<void> {
    if (this.state.stopped || !this.deps.assertLiveCert(live)) return;
    const now = this.now();
    const inventoryJson = stringifyJson(msg.inventory);
    const endpointsJson = stringifyJson(msg.endpoints);
    try {
      const existing = this.userStore.getNode(live.nodeId);
      if (!existing) {
        this.userStore.createNode({
          id: live.nodeId,
          userId: live.userId,
          name:
            this.config.nodeId && live.nodeId === this.config.nodeId
              ? this.nodeDisplayName(live.nodeId)
              : live.nodeId,
          status: 'enrolled',
          lastSeenAt: now,
          version: msg.version,
          directCapable: msg.direct_capable,
          inventoryJson,
          inventoryVersion: 1,
          endpointsJson,
          now,
        });
      } else {
        patchNode(this.db, live.nodeId, {
          lastSeenAt: now,
          version: msg.version,
          directCapable: msg.direct_capable,
          inventoryJson,
          inventoryVersion: existing.inventoryVersion + 1,
          endpointsJson,
        });
      }
      this.registry.updateMeta(
        live.nodeId,
        {
          version: msg.version,
          tmux: msg.tmux,
          directCapable: msg.direct_capable,
          inventory: msg.inventory,
          endpoints: msg.endpoints,
        },
        now
      );
      this.state.attachments.refreshLocal(live.nodeId);
      if (msg.hub) this.deps.applyAuthorizedHubAdvertisement(live.nodeId, msg.hub, 'uplink');
      if (this.deps.isWriter() && this.deps.isAuthorizedHub(live.nodeId, live.userId)) {
        this.deps.sendTokenSnapshotOnce(live);
      }
      await this.broadcastNodeList(live.userId);
    } catch {
      if (!this.state.stopped) throw new Error('node_status_failed');
    }
  }

  private toHubEndpoint(
    row: {
      hubNodeId: string;
      publicUrl: string;
      name: string | null;
      mode: HubMode;
      priority: number;
      writerEpoch: number;
      caFingerprint: string | null;
      lastSeenAt: number | null;
    },
    ownId: string | undefined
  ): HubEndpointInfo {
    const info: HubEndpointInfo = {
      nodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      priority: row.priority,
      writerEpoch: row.writerEpoch,
      online: row.hubNodeId === ownId || Boolean(this.registry.get(row.hubNodeId)?.authenticated),
      lastSeenAt: row.lastSeenAt,
    };
    if (row.name) info.name = row.name;
    if (row.caFingerprint !== undefined) info.caFingerprint = row.caFingerprint;
    return info;
  }

  nodeDisplayName(nodeId: string): string {
    const registry = this.userStore.getNode(nodeId)?.name?.trim();
    if (registry && registry !== nodeId) return registry;
    return this.config.siteName?.trim() || os.hostname().trim() || nodeId;
  }
}

function nodeListFingerprint(msg: NodeListMessage): string {
  return JSON.stringify({ ...msg, version: 0 });
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}
