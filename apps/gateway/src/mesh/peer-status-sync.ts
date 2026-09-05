import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import { isRecord, jsonStable, parseSeq } from './ctl';
import { jsonText } from './json-text';
import { sanitizeEndpoints } from './peer-dc-upgrade';
import {
  KEY_LOG_STATUS_DEBOUNCE_MS,
  type PeerManagerState,
  isPeerTrusted,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import type { KeyLogApplier, UplinkStatus } from './types';

export type PeerStatusSyncDeps = {
  sendPeerCtl: (live: LivePeer, msg: Record<string, unknown>) => void;
  notifyPeerEndpointsChanged: (nodeId?: string) => void;
  listenPort: () => number | undefined;
};

/** node.status 广播与 key log 同步：对端状态落库、密钥日志的服务端与应用端。 */
export class PeerStatusSync {
  private readonly state: PeerManagerState;
  private readonly deps: PeerStatusSyncDeps;
  private readonly keyLogApplier?: KeyLogApplier;
  private readonly statusProvider?: () => UplinkStatus & { name?: string };
  private keyLogHeadCache: { userId: string; seq: bigint; hash: Uint8Array } | null = null;
  private keyLogStatusDebounce: { clear: () => void } | null = null;

  constructor(
    state: PeerManagerState,
    opts: {
      keyLogApplier?: KeyLogApplier;
      statusProvider?: () => UplinkStatus & { name?: string };
      deps: PeerStatusSyncDeps;
    }
  ) {
    this.state = state;
    this.keyLogApplier = opts.keyLogApplier;
    this.statusProvider = opts.statusProvider;
    this.deps = opts.deps;
  }

  dispose(): void {
    this.keyLogStatusDebounce?.clear();
    this.keyLogStatusDebounce = null;
  }

  refreshAdvertisedStatus(): void {
    if (!this.statusProvider) return;
    for (const live of this.state.live.values()) {
      this.sendPeerStatus(live);
    }
  }

  notifyKeyLogHeadChanged(): void {
    this.keyLogHeadCache = null;
    if (this.state.stopped || this.keyLogStatusDebounce) return;
    this.keyLogStatusDebounce = this.state.scheduler.interval(() => {
      this.keyLogStatusDebounce?.clear();
      this.keyLogStatusDebounce = null;
      this.refreshAdvertisedStatus();
    }, KEY_LOG_STATUS_DEBOUNCE_MS);
  }

  async applyPeerStatus(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!isPeerTrusted(this.state, live.peerNodeId)) return;
    const peerNodeId = live.peerNodeId;
    const { userStore, uplink, scheduler } = this.state;
    const existing = userStore.getPeer(peerNodeId);
    const endpointsJson = jsonText(
      sanitizeEndpoints(msg.endpoints ?? existing?.endpointsJson ?? [], this.deps.listenPort())
    );
    const inventoryJson = jsonText(msg.inventory ?? existing?.inventoryJson ?? {});
    const directCapable =
      typeof msg.direct_capable === 'boolean'
        ? msg.direct_capable
        : (existing?.directCapable ?? false);
    const lastSeenAt = scheduler.now();
    const changed =
      !existing ||
      existing.endpointsJson !== endpointsJson ||
      existing.inventoryJson !== inventoryJson ||
      existing.directCapable !== directCapable;
    if (changed) {
      userStore.upsertPeer({
        nodeId: peerNodeId,
        name: existing?.name ?? peerNodeId,
        endpointsJson,
        inventoryJson,
        directCapable,
        lastSeenAt,
        listVersion: existing?.listVersion ?? 0,
      });
      this.deps.notifyPeerEndpointsChanged(peerNodeId);
    } else {
      userStore.touchPeerLastSeenAt(peerNodeId, lastSeenAt);
    }
    const head = isRecord(msg.key_log_head) ? msg.key_log_head : null;
    if (!head || !this.keyLogApplier) return;
    try {
      const remoteSeq = parseSeq(head.seq, 'key_log_head.seq');
      const local = await this.keyLogApplier.head(uplink.userId);
      if (remoteSeq > local.seq) {
        this.deps.sendPeerCtl(live, { t: 'key.log.req', from_seq: Number(local.seq + 1n) });
      }
    } catch {
      // ignore
    }
  }

  async serveKeyLog(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!this.keyLogApplier?.list) return;
    const fromSeq = parseSeq(msg.from_seq, 'from_seq');
    const requested = typeof msg.limit === 'number' ? msg.limit : 256;
    const limit = Math.min(256, Math.max(1, requested));
    const fetched = await this.keyLogApplier.list(
      this.state.uplink.userId,
      fromSeq,
      undefined,
      limit + 1
    );
    const hasMore = fetched.length > limit;
    const records = hasMore ? fetched.slice(0, limit) : fetched;
    this.deps.sendPeerCtl(live, {
      t: 'key.log.res',
      records: records.map((row) => ({
        seq: Number(row.seq),
        bytes: encodeBase64url(row.bytes),
        sig: encodeBase64url(row.sig),
      })),
      has_more: hasMore,
    });
  }

  async applyKeyLogRes(msg: Record<string, unknown>): Promise<void> {
    if (!this.keyLogApplier || !Array.isArray(msg.records)) return;
    const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
    for (const row of msg.records) {
      if (!isRecord(row) || typeof row.bytes !== 'string' || typeof row.sig !== 'string') continue;
      records.push({ bytes: decodeBase64url(row.bytes), sig: decodeBase64url(row.sig) });
    }
    if (records.length > 0) {
      await this.keyLogApplier.applyMany(this.state.uplink.userId, records);
    }
  }

  sendPeerStatus(live: LivePeer): void {
    const status = this.statusProvider?.();
    if (!status) return;
    const push = (head?: { seq: bigint; hash: Uint8Array }) => {
      const encoded = `${jsonStable(status)}\0${head ? `${head.seq.toString()}:${encodeBase64url(head.hash)}` : ''}`;
      if (encoded === live.lastAdvertisedStatusJson) return;
      live.lastAdvertisedStatusJson = encoded;
      this.deps.sendPeerCtl(live, {
        t: 'node.status',
        version: status.version,
        tmux: status.tmux,
        direct_capable: status.direct_capable,
        inventory: status.inventory,
        endpoints: status.endpoints,
        name: status.name,
        ...(head
          ? { key_log_head: { seq: Number(head.seq), hash: encodeBase64url(head.hash) } }
          : {}),
      });
    };
    if (!this.keyLogApplier) {
      push();
      return;
    }
    const userId = this.state.uplink.userId;
    const cached = this.keyLogHeadCache;
    if (cached && cached.userId === userId) {
      push({ seq: cached.seq, hash: cached.hash });
      return;
    }
    void this.keyLogApplier
      .head(userId)
      .then((head) => {
        if (this.state.live.get(live.peerNodeId) !== live && !live.retiring) return;
        this.keyLogHeadCache = { userId, seq: head.seq, hash: head.hash.slice() };
        push(head);
      })
      .catch(() => undefined);
  }
}
