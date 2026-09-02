import type { NodeEventPayload, NodeEventStatus, PeerReachKind } from './mesh-deps';

export const NODE_EVENT_DEDUPE_MAX = 1024;

export type NodeEventProjection = NodeEventPayload & {
  name?: string;
  version?: string | null;
  direct_capable?: boolean;
};

export class NodeEventDedupe {
  private readonly last = new Map<string, string>();
  private readonly syntheticOfflineGen = new Map<string, number>();

  constructor(private readonly max = NODE_EVENT_DEDUPE_MAX) {}

  get size(): number {
    return this.last.size;
  }

  fingerprint(event: NodeEventProjection): string {
    return JSON.stringify({
      status: event.status,
      reach: event.reach ?? null,
      transport: event.transport ?? null,
      rttMs: event.rttMs ?? null,
      inventory: event.inventory ?? null,
      version: event.version ?? null,
      direct_capable: event.direct_capable ?? false,
      name: event.name ?? '',
      dcBreaker: event.dcBreaker
        ? {
            cooling: event.dcBreaker.cooling,
            until: event.dcBreaker.until,
            failures: event.dcBreaker.failures,
            level: event.dcBreaker.level,
            lastFailureKind: event.dcBreaker.lastFailureKind,
          }
        : null,
    });
  }

  shouldEmitList(event: NodeEventProjection): boolean {
    const fp = this.fingerprint(event);
    if (this.last.get(event.nodeId) === fp) return false;
    this.remember(event.nodeId, fp);
    return true;
  }

  shouldEmitSyntheticOffline(nodeId: string, generation: number): boolean {
    if (this.syntheticOfflineGen.get(nodeId) === generation) return false;
    this.syntheticOfflineGen.set(nodeId, generation);
    this.remember(
      nodeId,
      this.fingerprint({ nodeId, status: 'offline' satisfies NodeEventStatus })
    );
    return true;
  }

  onRevoke(nodeId: string): void {
    this.last.delete(nodeId);
    this.syntheticOfflineGen.delete(nodeId);
  }

  clear(): void {
    this.last.clear();
    this.syntheticOfflineGen.clear();
  }

  private remember(nodeId: string, fp: string): void {
    this.last.delete(nodeId);
    this.last.set(nodeId, fp);
    while (this.last.size > this.max) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
      this.syntheticOfflineGen.delete(oldest);
    }
  }
}
