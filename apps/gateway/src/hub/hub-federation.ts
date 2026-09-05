import type { LinkSession } from '@tmex/shared/link';
import type {
  HubAdvertisement,
  HubAttachmentsMessage,
  HubForwardMessage,
  HubMode,
  HubNotWriterError,
  HubWriteForwardMessage,
} from '@tmex/shared/uplink';
import { type MeshHubRecord, type MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
import { RtcHubRouteTable } from '../mesh/rtc/signaling';
import { AttachmentSnapshotAssembler, paginateHubAttachments } from './hub-attachments';
import {
  HUB_TOKENS_ACK_WAIT_MS,
  applyHubTokensMessage,
  assertHubTokensEncodedSize,
  hubTokensAck,
  peerSupportsHubTokens,
  snapshotHubTokensMessages,
} from './hub-tokens';
import type { NodeRegistry } from './node-registry';
import type { HubTokensMessage, RtcSignalMessage, UplinkCtlMessage } from './uplink-protocol';
import type { LiveConnection, UplinkRoleDeps, UplinkServerState } from './uplink-server-state';
import type { UplinkTimer } from './uplink-server-timers';
import {
  WRITE_FORWARD_OVERSIZED_ERROR,
  WriteForwardIdempotencyCache,
  assertWriteForwardEncodedSize,
  chunkWriteForwardAck,
  writeForwardDigest,
} from './writer-forward';

export const HUB_SPLIT_BRAIN_LOG_INTERVAL_MS = 60_000;
export const HUB_UNAUTHORIZED_HUB_AD_LOG_INTERVAL_MS = 10 * 60 * 1000;

export type HubFederationDeps = UplinkRoleDeps & {
  mode: () => HubMode;
  writerEpoch: () => number;
  setMode: (mode: HubMode) => void;
  notWriterError: () => HubNotWriterError;
  authorizedHubRecords: () => MeshHubRecord[];
  send: (link: LinkSession, msg: UplinkCtlMessage) => void;
  broadcastAllNodeLists: () => void;
  resetCrossHubRelays: (hubId?: string) => void;
  onNewAuthorizedHub?: (hubNodeId: string) => void;
};

export type HubFederationOptions = {
  state: UplinkServerState;
  userStore: UserStore;
  registry: NodeRegistry;
  meshHubs: MeshHubStore;
  now: () => number;
  attachmentKeepaliveMs: number;
  forwardHubCtl?: (msg: HubAttachmentsMessage | HubForwardMessage) => void;
  onWriteForward?: (
    fromHubId: string,
    msg: HubWriteForwardMessage
  ) => Promise<HubWriteForwardMessage>;
  deps: HubFederationDeps;
};

/** 跨 hub 协作：注册令牌复制、附着广播、rtc 转发、写转发与 hub 广告/围栏。 */
export class HubFederation {
  private readonly state: UplinkServerState;
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly meshHubs: MeshHubStore;
  private readonly now: () => number;
  private readonly attachmentKeepaliveMs: number;
  private readonly forwardHubCtl?: (msg: HubAttachmentsMessage | HubForwardMessage) => void;
  private readonly onWriteForward?: (
    fromHubId: string,
    msg: HubWriteForwardMessage
  ) => Promise<HubWriteForwardMessage>;
  private readonly deps: HubFederationDeps;
  private readonly rtcHubRoutes: RtcHubRouteTable;
  private attachmentRevision = 0;
  private readonly attachmentAssembler = new AttachmentSnapshotAssembler();
  private readonly writeForwardCache = new WriteForwardIdempotencyCache();
  private attachmentKeepalive: UplinkTimer | null = null;
  private readonly tokenAckWaiters = new Map<
    string,
    { acked: Set<string>; pending: Set<string> }
  >();
  private readonly tokenSnapshots = new Set<string>();
  private lastSplitBrainLogAt: number | null = null;
  private readonly lastUnauthorizedHubAdLog = new Map<string, number>();

  constructor(opts: HubFederationOptions) {
    this.state = opts.state;
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.meshHubs = opts.meshHubs;
    this.now = opts.now;
    this.attachmentKeepaliveMs = opts.attachmentKeepaliveMs;
    this.forwardHubCtl = opts.forwardHubCtl;
    this.onWriteForward = opts.onWriteForward;
    this.deps = opts.deps;
    this.rtcHubRoutes = new RtcHubRouteTable({ now: opts.now });
  }

  async replicateEnrollmentTokens(
    msg: HubTokensMessage,
    waitMs = HUB_TOKENS_ACK_WAIT_MS
  ): Promise<string[]> {
    if (!this.deps.isWriter()) return [];
    const targets = this.tokenReplicationTargets();
    if (targets.length === 0) return [];
    const id = msg.id ?? crypto.randomUUID();
    const framed: HubTokensMessage = { ...msg, id };
    const pending = new Set(targets.map((row) => row.nodeId));
    this.tokenAckWaiters.set(id, { acked: new Set(), pending });
    for (const row of targets) {
      this.deps.send(row.link, framed);
    }
    if (waitMs <= 0) return [];
    const deadline = this.now() + waitMs;
    while (!this.state.stopped && this.now() < deadline) {
      const waiter = this.tokenAckWaiters.get(id);
      if (!waiter || waiter.pending.size === 0) break;
      await this.state.timers.sleep(20);
    }
    const waiter = this.tokenAckWaiters.get(id);
    this.tokenAckWaiters.delete(id);
    return waiter ? [...waiter.acked] : [];
  }

  private tokenReplicationTargets(): Array<{ nodeId: string; link: LinkSession }> {
    const out: Array<{ nodeId: string; link: LinkSession }> = [];
    for (const entry of this.registry.listAuthenticated()) {
      if (entry.nodeId === this.deps.hubNodeId()) continue;
      if (!this.deps.isAuthorizedHub(entry.nodeId, entry.userId)) continue;
      if (
        !peerSupportsHubTokens(entry.meta.version ?? this.userStore.getNode(entry.nodeId)?.version)
      ) {
        continue;
      }
      out.push({ nodeId: entry.nodeId, link: entry.link });
    }
    return out;
  }

  sendTokenSnapshot(live: LiveConnection): void {
    const version =
      this.registry.get(live.nodeId)?.meta.version ?? this.userStore.getNode(live.nodeId)?.version;
    if (!peerSupportsHubTokens(version)) return;
    if (!this.deps.isAuthorizedHub(live.nodeId, live.userId)) return;
    const revision = this.userStore.nextEnrollmentTokenRevision(this.deps.writerEpoch());
    const id = crypto.randomUUID();
    const pages = snapshotHubTokensMessages(this.userStore, revision, id, live.userId);
    for (const page of pages) {
      assertHubTokensEncodedSize(page);
      this.deps.send(live.link, page);
    }
  }

  private knownMaxWriterEpoch(): number {
    let max = this.deps.writerEpoch();
    for (const row of this.meshHubs.list()) {
      if (row.writerEpoch > max) max = row.writerEpoch;
    }
    return max;
  }

  handleHubTokens(live: LiveConnection, msg: HubTokensMessage): void {
    if (!this.deps.isAuthorizedHub(live.nodeId, live.userId)) {
      console.warn(`[hub] hub.tokens rejected from unauthorized node=${live.nodeId}`);
      return;
    }
    if (msg.ack) {
      const waiter = msg.id ? this.tokenAckWaiters.get(msg.id) : undefined;
      if (waiter) {
        waiter.acked.add(live.nodeId);
        waiter.pending.delete(live.nodeId);
      }
      return;
    }
    const writerId = pickWriterHub(this.deps.authorizedHubRecords());
    if (live.nodeId !== writerId) {
      console.warn(
        `[hub] hub.tokens upsert/tombstone dropped: sender=${live.nodeId} is not current writer=${writerId}`
      );
      return;
    }
    const senderEpoch = this.meshHubs.get(live.nodeId)?.writerEpoch ?? 0;
    const localMax = this.knownMaxWriterEpoch();
    if (senderEpoch < localMax) {
      console.warn(
        `[hub] hub.tokens upsert/tombstone dropped: senderEpoch=${senderEpoch} < localMax=${localMax} from=${live.nodeId}`
      );
      return;
    }
    applyHubTokensMessage(this.userStore, msg, live.userId);
    if (msg.id) this.deps.send(live.link, hubTokensAck(msg));
  }

  async handleHubWriteForward(live: LiveConnection, msg: HubWriteForwardMessage): Promise<void> {
    if (msg.ack) return;
    if (!this.deps.isAuthorizedHub(live.nodeId, live.userId)) {
      console.warn(`[hub] hub.write-forward rejected from unauthorized node=${live.nodeId}`);
      return;
    }
    if (!msg.id) return;
    const ownId = this.deps.hubNodeId();
    const epoch = this.deps.writerEpoch();
    const writerMismatch =
      !this.deps.isWriter() ||
      (msg.writerHubId !== undefined && ownId !== undefined && msg.writerHubId !== ownId) ||
      (msg.writerEpoch !== undefined && msg.writerEpoch !== epoch);
    if (writerMismatch) {
      this.sendWriteForwardAck(live.link, {
        t: 'hub.write-forward',
        id: msg.id,
        ack: true,
        status: 409,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.deps.notWriterError()),
      });
      return;
    }
    try {
      assertWriteForwardEncodedSize(msg);
    } catch {
      this.sendWriteForwardAck(live.link, {
        t: 'hub.write-forward',
        id: msg.id,
        ack: true,
        status: 413,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: WRITE_FORWARD_OVERSIZED_ERROR }),
      });
      return;
    }
    const digest = writeForwardDigest(msg);
    const cached = this.writeForwardCache.get(live.nodeId, msg.id);
    if (cached) {
      if (cached.digest === digest) {
        this.sendWriteForwardAck(live.link, cached.ack);
        return;
      }
      this.sendWriteForwardAck(live.link, {
        t: 'hub.write-forward',
        id: msg.id,
        ack: true,
        status: 409,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'idempotency_conflict' }),
      });
      return;
    }
    if (!this.onWriteForward) return;
    try {
      const ack = await this.onWriteForward(live.nodeId, msg);
      this.writeForwardCache.set(live.nodeId, msg.id, digest, ack);
      this.sendWriteForwardAck(live.link, ack);
    } catch (err) {
      console.warn(
        `[hub] hub.write-forward failed from=${live.nodeId}: ${err instanceof Error ? err.message : String(err)}`
      );
      this.sendWriteForwardAck(live.link, {
        t: 'hub.write-forward',
        id: msg.id,
        ack: true,
        status: 500,
        body: JSON.stringify({ error: 'forward_failed' }),
      });
    }
  }

  private sendWriteForwardAck(link: LinkSession, ack: HubWriteForwardMessage): void {
    for (const part of chunkWriteForwardAck(ack)) {
      this.deps.send(link, part);
    }
  }

  publishLocalAttachments(): void {
    const self = this.deps.hubNodeId();
    if (!self) return;
    this.state.attachments.expire();
    for (const entry of this.registry.listAuthenticated()) {
      if (entry.nodeId === self) continue;
      this.state.attachments.attachLocal(entry.nodeId);
    }
    this.emitAttachments(
      this.registry
        .listAuthenticated()
        .filter((entry) => entry.nodeId !== self)
        .map((entry) => ({ nodeId: entry.nodeId, attached: true })),
      true
    );
  }

  ingestHubAttachments(fromHubId: string, msg: HubAttachmentsMessage): void {
    if (!this.deps.isAuthorizedHub(fromHubId)) {
      console.warn(`[hub] hub.attachments rejected from unauthorized node=${fromHubId}`);
      return;
    }
    const assembled = this.attachmentAssembler.push(fromHubId, msg);
    if (!assembled) return;
    const result = this.state.attachments.applyFromHub(fromHubId, assembled.entries, {
      revision: assembled.revision,
      full: assembled.full,
    });
    if (result !== 'applied') return;
    if (this.deps.isWriter()) this.broadcastAttachmentUnion();
    this.deps.broadcastAllNodeLists();
  }

  ingestHubForward(fromHubId: string, msg: HubForwardMessage): void {
    if (!this.deps.isAuthorizedHub(fromHubId) || !this.deps.isAuthorizedHub(msg.originHubId)) {
      console.warn(`[hub] hub.forward rejected from unauthorized node=${fromHubId}`);
      return;
    }
    this.dispatchHubForward(fromHubId, msg);
  }

  handleHubAttachments(live: LiveConnection, msg: HubAttachmentsMessage): void {
    this.ingestHubAttachments(live.nodeId, msg);
  }

  handleHubForward(live: LiveConnection, msg: HubForwardMessage): void {
    this.ingestHubForward(live.nodeId, msg);
  }

  private emitAttachments(entries: HubAttachmentsMessage['entries'], full = false): void {
    const revision = ++this.attachmentRevision;
    const pages = paginateHubAttachments(entries, {
      revision,
      snapshotId: crypto.randomUUID(),
      full,
    });
    if (this.deps.isWriter()) {
      for (const msg of pages) this.broadcastHubCtl(msg);
      return;
    }
    for (const msg of pages) this.forwardHubCtl?.(msg);
  }

  private broadcastAttachmentUnion(): void {
    if (!this.deps.isWriter()) return;
    this.state.attachments.expire();
    this.emitAttachments(this.state.attachments.snapshotEntries(), true);
  }

  private broadcastHubCtl(msg: HubAttachmentsMessage | HubForwardMessage): void {
    for (const row of this.hubCtlTargets()) {
      this.deps.send(row.link, msg);
    }
  }

  private hubCtlTargets(): Array<{ nodeId: string; link: LinkSession }> {
    return this.tokenReplicationTargets();
  }

  noteLocalAttach(nodeId: string): void {
    const self = this.deps.hubNodeId();
    if (!self || nodeId === self) return;
    this.state.attachments.attachLocal(nodeId);
    if (this.deps.isWriter()) this.broadcastAttachmentUnion();
    else this.emitAttachments([{ nodeId, attached: true }]);
  }

  noteLocalDetach(nodeId: string, dropAsHub: boolean): void {
    this.state.attachments.detachLocal(nodeId);
    if (dropAsHub) {
      this.state.attachments.dropHub(nodeId);
      this.deps.resetCrossHubRelays(nodeId);
    }
    if (this.deps.isWriter()) this.broadcastAttachmentUnion();
    else this.emitAttachments([{ nodeId, attached: false }]);
  }

  private dispatchHubForward(fromHubId: string, msg: HubForwardMessage): void {
    const self = this.deps.hubNodeId();
    if (!self) return;
    if (msg.visitedHubIds.includes(self)) return;
    if (msg.visitedHubIds.length > 2) return;
    this.rtcHubRoutes.remember(msg.signal.rtcSession, msg.returnHubId);
    const inner: RtcSignalMessage = {
      t: 'rtc.signal',
      rtcSession: msg.signal.rtcSession,
      from: msg.signal.from,
      to: msg.signal.to,
      ...(msg.signal.sdp !== undefined ? { sdp: msg.signal.sdp } : {}),
      ...(msg.signal.candidate !== undefined ? { candidate: msg.signal.candidate } : {}),
    };
    const target = this.registry.get(inner.to);
    if (target?.authenticated) {
      this.deps.send(target.link, inner);
      return;
    }
    const dest = this.state.attachments.attachedHubId(inner.to);
    if (!dest || dest === self || dest === fromHubId) return;
    if (msg.visitedHubIds.length >= 2) return;
    if (!this.deps.isAuthorizedHub(dest)) return;
    this.sendHubForward(dest, {
      ...msg,
      visitedHubIds: [...msg.visitedHubIds, self],
    });
  }

  private sendHubForward(destHubId: string, msg: HubForwardMessage): void {
    if (this.deps.isWriter()) {
      const entry = this.registry.get(destHubId);
      if (
        entry?.authenticated &&
        this.deps.isAuthorizedHub(destHubId, entry.userId) &&
        peerSupportsHubTokens(entry.meta.version ?? this.userStore.getNode(destHubId)?.version)
      ) {
        this.deps.send(entry.link, msg);
      }
      return;
    }
    this.forwardHubCtl?.(msg);
  }

  forwardRtcAcrossHubs(live: LiveConnection, msg: RtcSignalMessage): void {
    const self = this.deps.hubNodeId();
    if (!self) return;
    const dest =
      this.rtcHubRoutes.lookup(msg.rtcSession) ?? this.state.attachments.attachedHubId(msg.to);
    if (!dest || dest === self) return;
    if (!this.deps.isAuthorizedHub(dest, live.userId)) return;
    this.sendHubForward(dest, {
      t: 'hub.forward',
      kind: 'rtc.signal',
      originHubId: self,
      returnHubId: self,
      visitedHubIds: [self],
      signal: {
        rtcSession: msg.rtcSession,
        from: msg.from,
        to: msg.to,
        ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
        ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
      },
    });
  }

  startAttachmentKeepalive(): void {
    this.clearAttachmentKeepalive();
    if (this.attachmentKeepaliveMs <= 0) return;
    this.attachmentKeepalive = this.state.timers.interval(
      'attachment keepalive',
      () => {
        if (this.state.stopped) return;
        this.publishLocalAttachments();
      },
      this.attachmentKeepaliveMs
    );
  }

  clearAttachmentKeepalive(): void {
    this.attachmentKeepalive?.clear();
    this.attachmentKeepalive = null;
  }

  applyAuthorizedHubAdvertisement(
    hubNodeId: string,
    ad: HubAdvertisement,
    source: 'uplink' | 'peer-status' = 'uplink'
  ): void {
    const id = hubNodeId.toLowerCase();
    if (!this.deps.isAuthorizedHub(id)) {
      this.warnUnauthorizedHubAd(id);
      return;
    }
    const now = this.now();
    const existing = this.meshHubs.get(id);
    const liveName = this.registry.get(id)?.meta.name?.trim();
    this.meshHubs.upsert(
      {
        hubNodeId: id,
        publicUrl: ad.publicUrl,
        name: liveName && liveName !== id ? liveName : (existing?.name ?? null),
        mode: ad.mode,
        priority: ad.priority,
        writerEpoch: ad.writerEpoch,
        caFingerprint:
          ad.caFingerprint === undefined ? (existing?.caFingerprint ?? null) : ad.caFingerprint,
        online: true,
        lastSeenAt: now,
      },
      now
    );
    if (!existing && source === 'uplink' && id !== this.deps.hubNodeId()) {
      this.deps.onNewAuthorizedHub?.(id);
    }
    this.maybeFenceFromPeer(id, ad, source);
  }

  private warnUnauthorizedHubAd(nodeId: string): void {
    const now = this.now();
    const prev = this.lastUnauthorizedHubAdLog.get(nodeId);
    if (prev !== undefined && now - prev < HUB_UNAUTHORIZED_HUB_AD_LOG_INTERVAL_MS) return;
    this.lastUnauthorizedHubAdLog.set(nodeId, now);
    console.warn(`[hub] ignored hub advertisement from unauthorized node=${nodeId}`);
  }

  private maybeFenceFromPeer(
    hubNodeId: string,
    ad: HubAdvertisement,
    source: 'uplink' | 'peer-status'
  ): void {
    const ownId = this.deps.hubNodeId();
    if (ad.mode !== 'active' || hubNodeId === ownId || this.deps.mode() !== 'active') return;
    if (ad.writerEpoch > this.deps.writerEpoch()) {
      const prefix = source === 'peer-status' ? '[hub] fenced by peer status' : '[hub] fenced';
      console.error(`${prefix}: higher writerEpoch=${ad.writerEpoch} from hub=${hubNodeId}`);
      this.deps.setMode('standby');
      return;
    }
    if (ad.writerEpoch === this.deps.writerEpoch()) {
      const now = this.now();
      if (
        this.lastSplitBrainLogAt === null ||
        now - this.lastSplitBrainLogAt >= HUB_SPLIT_BRAIN_LOG_INTERVAL_MS
      ) {
        this.lastSplitBrainLogAt = now;
        console.warn(
          `[hub] split-brain: equal writerEpoch=${ad.writerEpoch} from hub=${hubNodeId}`
        );
      }
    }
  }

  sendTokenSnapshotOnce(live: LiveConnection): void {
    const snapKey = `${live.nodeId}:${live.generation}`;
    if (this.tokenSnapshots.has(snapKey)) return;
    this.tokenSnapshots.add(snapKey);
    this.sendTokenSnapshot(live);
  }
}

/** 启动时若已知存在更高 writerEpoch 的活跃 hub，则被围栏降为 standby。 */
export function resolveStartMode(params: {
  configMode: HubMode;
  ownId: string | undefined;
  writerEpoch: number;
  hubs: MeshHubRecord[];
  isAuthorizedHub: (nodeId: string) => boolean;
}): HubMode {
  const higher = params.hubs.find(
    (row) =>
      params.isAuthorizedHub(row.hubNodeId) &&
      row.mode === 'active' &&
      row.writerEpoch > params.writerEpoch &&
      row.hubNodeId !== params.ownId
  );
  if (!higher) return params.configMode;
  console.error(
    `[hub] starting fenced: higher writerEpoch=${higher.writerEpoch} from hub=${higher.hubNodeId}`
  );
  return 'standby';
}
