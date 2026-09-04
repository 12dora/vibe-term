import type { LinkSession } from '@tmex/shared/link';
import type { RelayEnvelope } from '@tmex/shared/relay';

export type RelayLiveNode = {
  tenantId: string;
  nodeId: string;
  link: LinkSession;
  generation: number;
  tokenEpoch: number;
  /** 认证时用的令牌哈希；重新签发令牌后旧链路据此被踢，且认证后的每条消息都复查。 */
  tokenHash: string;
  protoVersion: number;
  clientVersion: string;
  statusBlob: RelayEnvelope | null;
  statusEpoch: number;
  misses: number;
  awaitingPong: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  connectedAt: number;
  pingAt: number | null;
  rttMs: number | null;
  reconnects: number;
};

export type RelayRegisterInput = {
  tenantId: string;
  nodeId: string;
  link: LinkSession;
  tokenEpoch: number;
  tokenHash: string;
  protoVersion: number;
  clientVersion: string;
  connectedAt?: number;
};

export function memberKey(tenantId: string, nodeId: string): string {
  return `${tenantId}\0${nodeId}`;
}

export function noteRelayPing(live: RelayLiveNode, now: number): void {
  live.pingAt = now;
}

export function noteRelayPong(live: RelayLiveNode, now: number): void {
  live.awaitingPong = false;
  live.misses = 0;
  if (live.pingAt == null) return;
  live.rttMs = Math.max(0, now - live.pingAt);
  live.pingAt = null;
}

/** 内存注册表：租户 → 节点 → 活链路。持久化的成员关系在 `relay_nodes`。 */
export class RelayRegistry {
  private generation = 0;
  private readonly byTenant = new Map<string, Map<string, RelayLiveNode>>();
  private readonly byLink = new Map<LinkSession, RelayLiveNode>();
  /** 每租户「逻辑流」计数：一条中转流只算一次（源 + 目标共用一份额度）。 */
  private readonly tenantStreams = new Map<string, number>();
  /** 每成员当前参与的逻辑流数（一条中转流在源、目标上各 +1）。 */
  private readonly memberStreams = new Map<string, number>();
  /** 进程内重连次数，断线后仍保留。 */
  private readonly reconnects = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly linkRemovedHandlers: Array<(live: RelayLiveNode) => void> = [];

  put(input: RelayRegisterInput): { live: RelayLiveNode; replaced: RelayLiveNode | null } {
    const previous = this.get(input.tenantId, input.nodeId) ?? null;
    if (previous) this.removeLink(previous.link);
    this.generation += 1;
    const key = memberKey(input.tenantId, input.nodeId);
    const reconnects = this.nextReconnects(key, previous !== null);
    const live: RelayLiveNode = {
      tenantId: input.tenantId,
      nodeId: input.nodeId,
      link: input.link,
      generation: this.generation,
      tokenEpoch: input.tokenEpoch,
      tokenHash: input.tokenHash,
      protoVersion: input.protoVersion,
      clientVersion: input.clientVersion,
      statusBlob: null,
      statusEpoch: 0,
      misses: 0,
      awaitingPong: false,
      heartbeat: null,
      connectedAt: input.connectedAt ?? Date.now(),
      pingAt: null,
      rttMs: null,
      reconnects,
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
    return this.tenantStreams.get(tenantId) ?? 0;
  }

  /**
   * 并发流额度：**先占位再 await**，否则同时到达的多条 OPEN 会一起读到旧计数把配额冲破。
   * 失败（目标拒绝 / pump 结束）时必须 `releaseStream` 归还。
   */
  reserveStream(tenantId: string, limit: number): boolean {
    const used = this.tenantStreams.get(tenantId) ?? 0;
    if (used >= limit) return false;
    this.tenantStreams.set(tenantId, used + 1);
    return true;
  }

  releaseStream(tenantId: string): void {
    const used = this.tenantStreams.get(tenantId) ?? 0;
    if (used <= 1) this.tenantStreams.delete(tenantId);
    else this.tenantStreams.set(tenantId, used - 1);
  }

  memberStreamCount(tenantId: string, nodeId: string): number {
    return this.memberStreams.get(memberKey(tenantId, nodeId)) ?? 0;
  }

  reserveMemberPair(tenantId: string, sourceId: string, targetId: string): void {
    this.bumpMemberStream(tenantId, sourceId, 1);
    this.bumpMemberStream(tenantId, targetId, 1);
  }

  releaseMemberPair(tenantId: string, sourceId: string, targetId: string): void {
    this.bumpMemberStream(tenantId, sourceId, -1);
    this.bumpMemberStream(tenantId, targetId, -1);
  }

  reconnectsOf(tenantId: string, nodeId: string): number {
    return this.reconnects.get(memberKey(tenantId, nodeId)) ?? 0;
  }

  onLinkRemoved(handler: (live: RelayLiveNode) => void): void {
    this.linkRemovedHandlers.push(handler);
  }

  forgetMember(tenantId: string, nodeId: string): void {
    const key = memberKey(tenantId, nodeId);
    this.reconnects.delete(key);
    this.seen.delete(key);
    this.memberStreams.delete(key);
    const live = this.get(tenantId, nodeId);
    if (live) live.reconnects = 0;
  }

  forgetTenant(tenantId: string): void {
    const prefix = `${tenantId}\0`;
    for (const key of this.reconnects.keys()) {
      if (key.startsWith(prefix)) this.reconnects.delete(key);
    }
    for (const key of this.seen) {
      if (key.startsWith(prefix)) this.seen.delete(key);
    }
    for (const key of this.memberStreams.keys()) {
      if (key.startsWith(prefix)) this.memberStreams.delete(key);
    }
    this.tenantStreams.delete(tenantId);
    for (const live of this.listTenant(tenantId)) live.reconnects = 0;
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
    for (const handler of this.linkRemovedHandlers) handler(live);
    return live;
  }

  all(): RelayLiveNode[] {
    return [...this.byLink.values()];
  }

  clear(): void {
    for (const link of [...this.byLink.keys()]) this.removeLink(link);
    this.tenantStreams.clear();
    this.memberStreams.clear();
    this.reconnects.clear();
    this.seen.clear();
  }

  private nextReconnects(key: string, replacing: boolean): number {
    const prior = this.reconnects.get(key) ?? 0;
    const reconnects = replacing || this.seen.has(key) ? prior + 1 : 0;
    this.seen.add(key);
    this.reconnects.set(key, reconnects);
    return reconnects;
  }

  private bumpMemberStream(tenantId: string, nodeId: string, delta: number): void {
    const key = memberKey(tenantId, nodeId);
    const next = (this.memberStreams.get(key) ?? 0) + delta;
    if (next <= 0) this.memberStreams.delete(key);
    else this.memberStreams.set(key, next);
  }
}
