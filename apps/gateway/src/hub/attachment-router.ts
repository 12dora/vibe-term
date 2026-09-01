export const ATTACHMENT_TTL_MS = 5 * 60 * 1000;
export const ATTACHMENT_MAX_ENTRIES = 4096;

const NODE_ID_HEX = /^[0-9a-f]{32}$/i;

export type AttachmentRoute = {
  hubId: string;
  version: number;
  lastSeen: number;
};

export type AttachmentDeltaEntry = {
  nodeId: string;
  attached: boolean;
  hubId?: string;
};

export type ApplyAttachmentsOpts = {
  revision?: number;
  full?: boolean;
};

type StoredRoute = AttachmentRoute & { local: boolean };

function normId(id: string): string {
  return id.trim().toLowerCase();
}

function isNodeId(id: string): boolean {
  return NODE_ID_HEX.test(id);
}

export class AttachmentRouter {
  private readonly routes = new Map<string, StoredRoute>();
  private readonly lastRevision = new Map<string, number>();
  private readonly selfHubId: () => string | undefined;
  private readonly now: () => number;

  constructor(opts: { selfHubId: () => string | undefined; now?: () => number }) {
    this.selfHubId = opts.selfHubId;
    this.now = opts.now ?? Date.now;
  }

  size(): number {
    return this.routes.size;
  }

  lookup(nodeId: string): AttachmentRoute | undefined {
    const entry = this.routes.get(normId(nodeId));
    if (!entry) return undefined;
    return { hubId: entry.hubId, version: entry.version, lastSeen: entry.lastSeen };
  }

  attachedHubId(nodeId: string): string | undefined {
    return this.lookup(nodeId)?.hubId;
  }

  list(): Array<{ nodeId: string } & AttachmentRoute> {
    return [...this.routes.entries()].map(([nodeId, entry]) => ({
      nodeId,
      hubId: entry.hubId,
      version: entry.version,
      lastSeen: entry.lastSeen,
    }));
  }

  snapshotEntries(): AttachmentDeltaEntry[] {
    return this.list().map((row) => ({
      nodeId: row.nodeId,
      attached: true,
      hubId: row.hubId,
    }));
  }

  attachLocal(nodeId: string): AttachmentRoute {
    const id = normId(nodeId);
    const self = this.requireSelf();
    const prev = this.routes.get(id);
    const version = (prev?.version ?? 0) + 1;
    const entry: StoredRoute = {
      hubId: self,
      version,
      lastSeen: this.now(),
      local: true,
    };
    this.routes.set(id, entry);
    this.enforceCap();
    return { hubId: entry.hubId, version: entry.version, lastSeen: entry.lastSeen };
  }

  detachLocal(nodeId: string): boolean {
    const id = normId(nodeId);
    const prev = this.routes.get(id);
    if (!prev) return false;
    const self = this.selfHubId();
    if (self && prev.hubId !== self && !prev.local) return false;
    this.routes.delete(id);
    return true;
  }

  refreshLocal(nodeId: string): void {
    const id = normId(nodeId);
    const prev = this.routes.get(id);
    const self = this.selfHubId();
    if (!prev || !self || prev.hubId !== self) return;
    prev.lastSeen = this.now();
    prev.local = true;
  }

  applyFromHub(
    fromHubId: string,
    entries: AttachmentDeltaEntry[],
    opts?: ApplyAttachmentsOpts
  ): 'applied' | 'ignored' | 'rejected' {
    const from = normId(fromHubId);
    if (!isNodeId(from)) return 'rejected';
    if (entries.length > ATTACHMENT_MAX_ENTRIES) return 'rejected';
    const revision = opts?.revision;
    if (revision !== undefined) {
      const prev = this.lastRevision.get(from);
      if (prev !== undefined && revision < prev) return 'ignored';
      this.lastRevision.set(from, revision);
    }
    const now = this.now();
    const self = this.selfHubId();
    const attached = entries.filter((e) => e.attached && isNodeId(e.nodeId));
    if (opts?.full) {
      const keep = new Set(attached.map((e) => normId(e.nodeId)));
      const union = attached.some((e) => e.hubId && isNodeId(e.hubId) && normId(e.hubId) !== from);
      if (union) this.dropNonLocalNotIn(keep);
      else this.dropRemoteFrom(from, keep);
    }
    for (const raw of entries) {
      if (!isNodeId(raw.nodeId)) continue;
      const nodeId = normId(raw.nodeId);
      const claimed = raw.hubId && isNodeId(raw.hubId) ? normId(raw.hubId) : from;
      if (self && claimed === self) continue;
      if (!raw.attached) {
        const cur = this.routes.get(nodeId);
        if (cur && !cur.local && cur.hubId === claimed) this.routes.delete(nodeId);
        continue;
      }
      const cur = this.routes.get(nodeId);
      if (cur && cur.lastSeen > now) continue;
      this.routes.set(nodeId, {
        hubId: claimed,
        version: (cur?.version ?? 0) + 1,
        lastSeen: now,
        local: false,
      });
    }
    this.enforceCap();
    return 'applied';
  }

  dropHub(hubId: string): string[] {
    const id = normId(hubId);
    const dropped: string[] = [];
    for (const [nodeId, entry] of this.routes) {
      if (entry.local) continue;
      if (entry.hubId !== id) continue;
      this.routes.delete(nodeId);
      dropped.push(nodeId);
    }
    this.lastRevision.delete(id);
    return dropped;
  }

  expire(): string[] {
    const cutoff = this.now() - ATTACHMENT_TTL_MS;
    const dropped: string[] = [];
    for (const [nodeId, entry] of this.routes) {
      if (entry.lastSeen >= cutoff) continue;
      this.routes.delete(nodeId);
      dropped.push(nodeId);
    }
    return dropped;
  }

  private requireSelf(): string {
    const self = this.selfHubId();
    if (!self || !isNodeId(self)) throw new Error('attachment router missing self hub id');
    return normId(self);
  }

  private dropRemoteFrom(hubId: string, keep: ReadonlySet<string>): void {
    for (const [nodeId, entry] of this.routes) {
      if (entry.local) continue;
      if (entry.hubId !== hubId) continue;
      if (keep.has(nodeId)) continue;
      this.routes.delete(nodeId);
    }
  }

  private dropNonLocalNotIn(keepNodes: ReadonlySet<string>): void {
    for (const [nodeId, entry] of this.routes) {
      if (entry.local) continue;
      if (keepNodes.has(nodeId)) continue;
      this.routes.delete(nodeId);
    }
  }

  private enforceCap(): void {
    if (this.routes.size <= ATTACHMENT_MAX_ENTRIES) return;
    const remotes = [...this.routes.entries()]
      .filter(([, entry]) => !entry.local)
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen || a[0].localeCompare(b[0]));
    let overflow = this.routes.size - ATTACHMENT_MAX_ENTRIES;
    for (const [nodeId] of remotes) {
      if (overflow <= 0) break;
      this.routes.delete(nodeId);
      overflow -= 1;
    }
    if (this.routes.size <= ATTACHMENT_MAX_ENTRIES) return;
    const locals = [...this.routes.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen || a[0].localeCompare(b[0])
    );
    overflow = this.routes.size - ATTACHMENT_MAX_ENTRIES;
    for (const [nodeId] of locals) {
      if (overflow <= 0) break;
      this.routes.delete(nodeId);
      overflow -= 1;
    }
  }
}
