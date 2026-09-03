import type { LinkSession } from '@tmex/shared/link';
import type { RelayEnvelope } from '@tmex/shared/relay';

export type RelayLiveNode = {
  tenantId: string;
  nodeId: string;
  link: LinkSession;
  generation: number;
  tokenEpoch: number;
  protoVersion: number;
  clientVersion: string;
  directCapable: boolean;
  statusBlob: RelayEnvelope | null;
  statusEpoch: number;
  streams: number;
  misses: number;
  awaitingPong: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
};

export type RelayRegisterInput = {
  tenantId: string;
  nodeId: string;
  link: LinkSession;
  tokenEpoch: number;
  protoVersion: number;
  clientVersion: string;
};

/** 内存注册表：租户 → 节点 → 活链路。持久化的成员关系在 `relay_nodes`。 */
export class RelayRegistry {
  private generation = 0;
  private readonly byTenant = new Map<string, Map<string, RelayLiveNode>>();
  private readonly byLink = new Map<LinkSession, RelayLiveNode>();

  put(input: RelayRegisterInput): { live: RelayLiveNode; replaced: RelayLiveNode | null } {
    const previous = this.get(input.tenantId, input.nodeId) ?? null;
    if (previous) this.removeLink(previous.link);
    this.generation += 1;
    const live: RelayLiveNode = {
      tenantId: input.tenantId,
      nodeId: input.nodeId,
      link: input.link,
      generation: this.generation,
      tokenEpoch: input.tokenEpoch,
      protoVersion: input.protoVersion,
      clientVersion: input.clientVersion,
      directCapable: false,
      statusBlob: null,
      statusEpoch: 0,
      streams: 0,
      misses: 0,
      awaitingPong: false,
      heartbeat: null,
    };
    const tenant = this.byTenant.get(input.tenantId) ?? new Map<string, RelayLiveNode>();
    tenant.set(input.nodeId, live);
    this.byTenant.set(input.tenantId, tenant);
    this.byLink.set(input.link, live);
    return { live, replaced: previous };
  }

  get(tenantId: string, nodeId: string): RelayLiveNode | undefined {
    return this.byTenant.get(tenantId)?.get(nodeId);
  }

  fromLink(link: LinkSession): RelayLiveNode | undefined {
    return this.byLink.get(link);
  }

  listTenant(tenantId: string): RelayLiveNode[] {
    const tenant = this.byTenant.get(tenantId);
    return tenant ? [...tenant.values()] : [];
  }

  onlineTenantIds(): string[] {
    const out: string[] = [];
    for (const [tenantId, nodes] of this.byTenant) {
      if (nodes.size > 0) out.push(tenantId);
    }
    return out;
  }

  onlineCount(): number {
    let total = 0;
    for (const nodes of this.byTenant.values()) total += nodes.size;
    return total;
  }

  streamCount(tenantId: string): number {
    let total = 0;
    for (const node of this.listTenant(tenantId)) total += node.streams;
    return total;
  }

  removeLink(link: LinkSession): RelayLiveNode | undefined {
    const live = this.byLink.get(link);
    if (!live) return undefined;
    this.byLink.delete(link);
    const tenant = this.byTenant.get(live.tenantId);
    if (tenant?.get(live.nodeId) === live) {
      tenant.delete(live.nodeId);
      if (tenant.size === 0) this.byTenant.delete(live.tenantId);
    }
    return live;
  }

  all(): RelayLiveNode[] {
    return [...this.byLink.values()];
  }

  clear(): void {
    this.byTenant.clear();
    this.byLink.clear();
  }
}
