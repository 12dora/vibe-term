import type {
  RelayAttachRole,
  RelayChoice,
  RelayPeerPresence,
  RelayPresenceIndex,
  RelayPresenceSnapshot,
} from './relay-presence-types';
import { normalizeHubEndpointUrl } from './uplink-pool-url';

/** 与 hub presence 相同的 90 s 陈旧窗口：uplink 掉了之后仍把该中继上的对端视为在线。 */
export const RELAY_PRESENCE_STALE_MS = 90_000;

export type RelayPresencePeerInput = {
  id: string;
  online: boolean;
  rttMs?: number | null;
};

type RelayPresenceRow = {
  url: string;
  role: RelayAttachRole;
  connected: boolean;
  selfRttMs: number | null;
  peers: Map<string, RelayPeerPresence>;
  listVersion: number;
  updatedAt: number;
  staleUntil: number;
  priority: number;
};

function keyOf(url: string): string {
  return normalizeHubEndpointUrl(url);
}

function finiteRtt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 多中继在线索引：每个 URL 一行最新 `relay.list`，选路按 rtt(self,R)+rtt(peer,R)。
 * 2.2.x 对端只会出现在它挂着的那一台上，不假设多点在线。
 */
export class RelayPresence implements RelayPresenceIndex {
  private readonly rows = new Map<string, RelayPresenceRow>();
  private primary: string | null = null;

  snapshot(): RelayPresenceSnapshot[] {
    return [...this.rows.values()]
      .sort((a, b) => this.compareRows(a, b))
      .map((row) => ({
        url: row.url,
        role: row.role,
        connected: row.connected,
        selfRttMs: row.selfRttMs,
        peers: new Map(row.peers),
        listVersion: row.listVersion,
        updatedAt: row.updatedAt,
      }));
  }

  primaryUrl(): string | null {
    return this.primary;
  }

  relaysFor(peerId: string): string[] {
    const hits: RelayPresenceRow[] = [];
    for (const row of this.rows.values()) {
      if (!row.connected) continue;
      if (row.peers.get(peerId)?.online !== true) continue;
      hits.push(row);
    }
    hits.sort((a, b) => this.compareRows(a, b));
    return hits.map((row) => row.url);
  }

  chooseRelay(peerId: string, opts?: { exclude?: readonly string[] }): RelayChoice | null {
    const excluded = new Set((opts?.exclude ?? []).map(keyOf));
    const ranked: Array<{ row: RelayPresenceRow; scoreMs: number | null }> = [];
    for (const row of this.rows.values()) {
      if (!row.connected) continue;
      if (excluded.has(keyOf(row.url))) continue;
      if (row.peers.get(peerId)?.online !== true) continue;
      const selfRtt = finiteRtt(row.selfRttMs);
      const peerRtt = finiteRtt(row.peers.get(peerId)?.rttMs);
      ranked.push({
        row,
        scoreMs: selfRtt != null && peerRtt != null ? selfRtt + peerRtt : null,
      });
    }
    ranked.sort((a, b) => {
      const aComplete = a.scoreMs != null;
      const bComplete = b.scoreMs != null;
      if (aComplete !== bComplete) return aComplete ? -1 : 1;
      if (aComplete && bComplete && a.scoreMs !== b.scoreMs) {
        return (a.scoreMs ?? 0) - (b.scoreMs ?? 0);
      }
      return this.compareRows(a.row, b.row);
    });
    const best = ranked[0];
    if (!best) return null;
    return { url: best.row.url, role: best.row.role, scoreMs: best.scoreMs };
  }

  onlineUnion(now?: number): Set<string> {
    const ids = new Set<string>();
    for (const row of this.rows.values()) {
      if (!this.rowHoldsPresence(row, now)) continue;
      for (const [id, peer] of row.peers) {
        if (peer.online) ids.add(id);
      }
    }
    return ids;
  }

  /** 任意一行里出现过的对端（含已离线），供 primary 清单剪枝时保留 secondary-only 节点。 */
  knownPeerIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of this.rows.values()) {
      for (const id of row.peers.keys()) ids.add(id);
    }
    return ids;
  }

  listedPeerIds(url: string): string[] {
    const row = this.rows.get(keyOf(url));
    return row ? [...row.peers.keys()] : [];
  }

  listedNodes(exceptUrl?: string | null): Array<{
    id: string;
    online: boolean;
    rttMs: number | null;
    seenAt: number;
  }> {
    const skip = exceptUrl ? keyOf(exceptUrl) : null;
    const byId = new Map<
      string,
      { id: string; online: boolean; rttMs: number | null; seenAt: number }
    >();
    for (const row of this.rows.values()) {
      if (skip && keyOf(row.url) === skip) continue;
      for (const [id, peer] of row.peers) {
        const prev = byId.get(id);
        if (!prev || peer.seenAt >= prev.seenAt) {
          byId.set(id, { id, online: peer.online, rttMs: peer.rttMs, seenAt: peer.seenAt });
        }
      }
    }
    return [...byId.values()];
  }

  peersOnlineOn(url: string): number | null {
    const row = this.rows.get(keyOf(url));
    if (!row?.connected) return null;
    let n = 0;
    for (const peer of row.peers.values()) {
      if (peer.online) n += 1;
    }
    return n;
  }

  hasConnected(): boolean {
    for (const row of this.rows.values()) {
      if (row.connected) return true;
    }
    return false;
  }

  setPrimary(url: string | null): void {
    this.primary = url ? keyOf(url) : null;
    for (const row of this.rows.values()) {
      row.role = this.primary && keyOf(row.url) === this.primary ? 'primary' : 'secondary';
    }
    if (this.primary && !this.rows.has(this.primary) && url) {
      this.ensureRow(url, 0).role = 'primary';
    }
  }

  setPriority(url: string, priority: number): void {
    this.ensureRow(url, priority).priority = priority;
  }

  setConnected(url: string, connected: boolean, selfRttMs: number | null, now: number): void {
    const row = this.ensureRow(url, 0);
    row.connected = connected;
    row.selfRttMs = finiteRtt(selfRttMs);
    row.updatedAt = now;
    if (connected) row.staleUntil = 0;
  }

  setSelfRtt(url: string, rttMs: number | null): void {
    const row = this.rows.get(keyOf(url));
    if (!row) return;
    row.selfRttMs = finiteRtt(rttMs);
  }

  applyList(
    url: string,
    nodes: readonly RelayPresencePeerInput[],
    version: number,
    now: number
  ): void {
    const row = this.ensureRow(url, 0);
    if (version < row.listVersion) return;
    row.listVersion = version;
    row.updatedAt = now;
    const next = new Map<string, RelayPeerPresence>();
    for (const node of nodes) {
      next.set(node.id, {
        online: node.online,
        rttMs: finiteRtt(node.rttMs),
        seenAt: now,
      });
    }
    row.peers = next;
  }

  markDisconnected(url: string, now: number, staleMs = RELAY_PRESENCE_STALE_MS): void {
    const row = this.rows.get(keyOf(url));
    if (!row) return;
    row.connected = false;
    row.selfRttMs = null;
    row.updatedAt = now;
    row.staleUntil = now + staleMs;
  }

  /**
   * 陈旧窗口到期：只把「只在这一台上线」的对端标离线，返回这些 nodeId。
   * 其它中继（含仍在 hold 的）上还看得到的对端保持 online。
   */
  decay(url: string, now: number): string[] {
    const row = this.rows.get(keyOf(url));
    if (!row) return [];
    row.staleUntil = 0;
    if (row.connected) return [];
    const exclusive: string[] = [];
    for (const [id, peer] of row.peers) {
      if (!peer.online) continue;
      if (this.heldElsewhere(id, row.url, now)) continue;
      row.peers.set(id, { ...peer, online: false });
      exclusive.push(id);
    }
    return exclusive;
  }

  remove(url: string): void {
    const key = keyOf(url);
    this.rows.delete(key);
    if (this.primary === key) this.primary = null;
  }

  retainUrls(urls: readonly string[]): void {
    const keep = new Set(urls.map(keyOf));
    for (const key of [...this.rows.keys()]) {
      if (!keep.has(key)) this.rows.delete(key);
    }
    if (this.primary && !keep.has(this.primary)) this.primary = null;
  }

  private ensureRow(url: string, priority: number): RelayPresenceRow {
    const key = keyOf(url);
    const existing = this.rows.get(key);
    if (existing) return existing;
    const row: RelayPresenceRow = {
      url: key,
      role: this.primary === key ? 'primary' : 'secondary',
      connected: false,
      selfRttMs: null,
      peers: new Map(),
      listVersion: 0,
      updatedAt: 0,
      staleUntil: 0,
      priority,
    };
    this.rows.set(key, row);
    return row;
  }

  private rowHoldsPresence(row: RelayPresenceRow, now?: number): boolean {
    if (row.connected) return true;
    if (row.staleUntil <= 0) return false;
    if (now === undefined) return true;
    return now < row.staleUntil;
  }

  private heldElsewhere(peerId: string, exceptUrl: string, now: number): boolean {
    const skip = keyOf(exceptUrl);
    for (const row of this.rows.values()) {
      if (keyOf(row.url) === skip) continue;
      if (!this.rowHoldsPresence(row, now)) continue;
      if (row.peers.get(peerId)?.online === true) return true;
    }
    return false;
  }

  private compareRows(a: RelayPresenceRow, b: RelayPresenceRow): number {
    if (a.role === 'primary' && b.role !== 'primary') return -1;
    if (b.role === 'primary' && a.role !== 'primary') return 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.url.localeCompare(b.url);
  }
}
