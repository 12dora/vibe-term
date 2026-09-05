import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import { pumpHubRelay } from '../relay/hub-relay-pump';
import {
  HUB_RELAY_KIND,
  type HubRelayOpen,
  encodeHubRelayOpen,
  nextHubRelayHop,
  parseHubRelayOpen,
  validateHubRelay,
} from './hub-relay';
import type { NodeRegistry } from './node-registry';
import type { LiveConnection, UplinkRoleDeps, UplinkServerState } from './uplink-server-state';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export type HubRelayStreamsOptions = {
  state: UplinkServerState;
  userStore: UserStore;
  registry: NodeRegistry;
  openHubStream?: (hubId: string, payload: Uint8Array) => Promise<LinkStream | null>;
  deps: UplinkRoleDeps;
};

/** 跨 hub 的流量中继：本地投递、下一跳转发与跨 hub 流的生命周期跟踪。 */
export class HubRelayStreams {
  private readonly state: UplinkServerState;
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly openHubStream?: (
    hubId: string,
    payload: Uint8Array
  ) => Promise<LinkStream | null>;
  private readonly deps: UplinkRoleDeps;
  private readonly crossHubStreams = new Map<string, Set<LinkStream>>();

  constructor(opts: HubRelayStreamsOptions) {
    this.state = opts.state;
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.openHubStream = opts.openHubStream;
    this.deps = opts.deps;
  }

  ingestHubRelay(fromHubId: string, stream: LinkStream): void {
    const open = parseHubRelayOpen(stream.openPayload);
    if (!open) {
      stream.reset('invalid-relay');
      return;
    }
    void this.acceptHubRelay(fromHubId, stream, open);
  }

  resetCrossHubRelays(hubId?: string): void {
    const ids = hubId ? [hubId] : [...this.crossHubStreams.keys()];
    for (const id of ids) {
      const set = this.crossHubStreams.get(id);
      this.crossHubStreams.delete(id);
      if (!set) continue;
      for (const stream of set) {
        try {
          stream.reset('hub-down');
        } catch {
          /* already closed */
        }
      }
    }
  }

  async acceptHubRelay(fromHubId: string, stream: LinkStream, open: HubRelayOpen): Promise<void> {
    const targetCert = this.userStore.getCert(open.to);
    const sourceCert = this.userStore.getCert(open.from);
    const targetEntry = this.registry.get(open.to);
    const sameUser = Boolean(
      targetCert &&
        sourceCert &&
        targetCert.userId === sourceCert.userId &&
        this.userStore.getCert(fromHubId)?.userId === targetCert.userId
    );
    const verdict = validateHubRelay({
      to: open.to,
      from: open.from,
      originHubId: open.originHubId,
      visitedHubIds: open.visitedHubIds,
      hop: open.hop,
      peerHubId: fromHubId,
      isAuthorizedHub: (id) => this.deps.isAuthorizedHub(id),
      targetLocal: Boolean(targetEntry?.authenticated),
      sameUser,
      sourceRevoked: !sourceCert || sourceCert.revokedLogSeq !== null,
      targetKnown: targetCert != null && targetCert.revokedLogSeq === null,
    });
    if (verdict.ok) {
      await this.pumpToLocalNode(stream, open.to, open.from);
      return;
    }
    if (
      verdict.reason === 'offline' &&
      sameUser &&
      targetCert &&
      targetCert.revokedLogSeq === null
    ) {
      await this.forwardHubRelay(stream, open);
      return;
    }
    stream.reset(verdict.reason);
  }

  private async forwardHubRelay(stream: LinkStream, open: HubRelayOpen): Promise<void> {
    const self = this.deps.hubNodeId();
    if (!self) {
      stream.reset('offline');
      return;
    }
    const next = nextHubRelayHop(open, self);
    if (!next.ok) {
      stream.reset(next.reason);
      return;
    }
    const dest = this.state.attachments.attachedHubId(open.to);
    if (!dest || dest === self) {
      stream.reset('offline');
      return;
    }
    await this.openAndPumpHubRelay(stream, dest, next.open);
  }

  private async pumpToLocalNode(stream: LinkStream, to: string, from: string): Promise<void> {
    const targetEntry = this.registry.get(to);
    if (!targetEntry?.authenticated) {
      stream.reset('offline');
      return;
    }
    const outboundPayload = textEncoder.encode(JSON.stringify({ to, from }));
    let outbound: LinkStream;
    try {
      outbound = await targetEntry.link.openStream(outboundPayload);
    } catch {
      stream.reset('open-failed');
      return;
    }
    pumpHubRelay(stream, outbound);
  }

  async openAndPumpHubRelay(
    stream: LinkStream,
    destHubId: string,
    open: HubRelayOpen
  ): Promise<void> {
    if (!this.openHubStream) {
      stream.reset('offline');
      return;
    }
    let outbound: LinkStream;
    try {
      const opened = await this.openHubStream(destHubId, encodeHubRelayOpen(open));
      if (!opened) {
        stream.reset('offline');
        return;
      }
      outbound = opened;
    } catch {
      stream.reset('open-failed');
      return;
    }
    this.trackCrossHub(destHubId, stream, outbound);
    pumpHubRelay(stream, outbound);
  }

  private trackCrossHub(hubId: string, a: LinkStream, b: LinkStream): void {
    let set = this.crossHubStreams.get(hubId);
    if (!set) {
      set = new Set();
      this.crossHubStreams.set(hubId, set);
    }
    set.add(a);
    set.add(b);
    const untrack = (): void => {
      const current = this.crossHubStreams.get(hubId);
      if (!current) return;
      current.delete(a);
      current.delete(b);
      if (current.size === 0) this.crossHubStreams.delete(hubId);
    };
    a.onAbort(untrack);
    b.onAbort(untrack);
    void a.closed.then(untrack);
    void b.closed.then(untrack);
  }

  async routeNodeStream(live: LiveConnection, stream: LinkStream): Promise<void> {
    const hubOpen = parseHubRelayOpen(stream.openPayload);
    if (hubOpen) {
      await this.acceptHubRelay(live.nodeId, stream, hubOpen);
      return;
    }
    const open = parseRelayOpen(stream.openPayload);
    if (!open) {
      stream.reset('invalid-relay');
      return;
    }
    const targetCert = this.userStore.getCert(open.to);
    if (!targetCert || targetCert.revokedLogSeq !== null) {
      stream.reset(targetCert ? 'revoked' : 'unknown-cert');
      return;
    }
    if (targetCert.userId !== live.userId) {
      stream.reset('cross-user');
      return;
    }
    const targetEntry = this.registry.get(open.to);
    if (targetEntry?.authenticated) {
      const outboundPayload = textEncoder.encode(
        JSON.stringify({ ...open.raw, from: live.nodeId })
      );
      let outbound: LinkStream;
      try {
        outbound = await targetEntry.link.openStream(outboundPayload);
      } catch {
        stream.reset('open-failed');
        return;
      }
      pumpHubRelay(stream, outbound);
      return;
    }
    const self = this.deps.hubNodeId();
    const dest = this.state.attachments.attachedHubId(open.to);
    if (!self || !dest || dest === self) {
      stream.reset('offline');
      return;
    }
    await this.openAndPumpHubRelay(stream, dest, {
      kind: HUB_RELAY_KIND,
      to: open.to,
      from: live.nodeId,
      originHubId: self,
      visitedHubIds: [self],
      hop: 1,
    });
  }
}

function parseRelayOpen(payload: Uint8Array): { to: string; raw: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.to !== 'string' || obj.to.length === 0) return null;
    if (typeof obj.method === 'string') return null;
    return { to: obj.to, raw: obj };
  } catch {
    return null;
  }
}
