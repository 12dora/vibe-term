import type { RtcSignalMessage, RtcSignalOwner, RtcSignalRouter } from '../mesh-deps';

export const RTC_LOCAL_INBOX_MAX_SESSIONS = 32;
export const RTC_LOCAL_INBOX_MAX_MESSAGES = 16;
/** 入口上指向远端目标的 owner。本地目标由 accept 结束时 unregister。 */
export const RTC_REMOTE_OWNER_TTL_MS = 60_000;

export type RtcSessionOwner = {
  browserSessionId: string;
  targetNodeId: string;
};

type StoredOwner = RtcSessionOwner & { registeredAt: number };

export type SendCtl = (nodeId: string, msg: RtcSignalMessage) => void;

export type ShouldCacheLocal = (signal: RtcSignalMessage, sourceNodeId?: string) => boolean;

export type RtcSignalRouterOptions = {
  selfNodeId: string;
  sendCtl: SendCtl;
  shouldCacheLocal?: ShouldCacheLocal;
  maxInboxSessions?: number;
  maxInboxMessages?: number;
  now?: () => number;
  remoteOwnerTtlMs?: number;
};

export class MeshRtcSignalRouter implements RtcSignalRouter {
  private readonly selfNodeId: string;
  private readonly sendCtl: SendCtl;
  private readonly shouldCacheLocal: ShouldCacheLocal | null;
  private readonly maxInboxSessions: number;
  private readonly maxInboxMessages: number;
  private readonly now: () => number;
  private readonly remoteOwnerTtlMs: number;
  private readonly owners = new Map<string, StoredOwner>();
  private readonly subscribers = new Set<
    (signal: RtcSignalMessage, browserSessionId?: string) => void
  >();
  private readonly localListeners = new Map<string, Set<(signal: RtcSignalMessage) => void>>();
  private readonly localInbox = new Map<string, RtcSignalMessage[]>();

  constructor(opts: RtcSignalRouterOptions) {
    this.selfNodeId = opts.selfNodeId.toLowerCase();
    this.sendCtl = opts.sendCtl;
    this.shouldCacheLocal = opts.shouldCacheLocal ?? null;
    this.maxInboxSessions = opts.maxInboxSessions ?? RTC_LOCAL_INBOX_MAX_SESSIONS;
    this.maxInboxMessages = opts.maxInboxMessages ?? RTC_LOCAL_INBOX_MAX_MESSAGES;
    this.now = opts.now ?? Date.now;
    this.remoteOwnerTtlMs = opts.remoteOwnerTtlMs ?? RTC_REMOTE_OWNER_TTL_MS;
  }

  register(rtcSession: string, owner: RtcSessionOwner): void {
    this.sweepRemoteOwners();
    this.owners.set(rtcSession, {
      browserSessionId: owner.browserSessionId,
      targetNodeId: owner.targetNodeId.toLowerCase(),
      registeredAt: this.now(),
    });
  }

  unregister(rtcSession: string): void {
    this.owners.delete(rtcSession);
    this.localListeners.delete(rtcSession);
    this.localInbox.delete(rtcSession);
  }

  ownerOf(rtcSession: string): RtcSessionOwner | undefined {
    this.sweepRemoteOwners();
    return this.publicOwner(this.owners.get(rtcSession));
  }

  send(signal: RtcSignalMessage, caller?: RtcSignalOwner): void {
    this.sweepRemoteOwners();
    const owner = this.owners.get(signal.rtcSession);
    if (!owner) return;
    if (signal.from === 'browser') {
      if (caller && caller.sid !== owner.browserSessionId) return;
      if (signal.to.toLowerCase() !== owner.targetNodeId) return;
      this.forwardToNode(owner.targetNodeId, signal);
      return;
    }
    if (signal.from === 'node') {
      if (
        signal.to.toLowerCase() !== owner.targetNodeId &&
        signal.to.toLowerCase() !== this.selfNodeId
      ) {
        return;
      }
      this.emitBrowser(signal);
    }
  }

  subscribe(cb: (signal: RtcSignalMessage, browserSessionId?: string) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  onLocal(rtcSession: string, cb: (signal: RtcSignalMessage) => void): () => void {
    let set = this.localListeners.get(rtcSession);
    if (!set) {
      set = new Set();
      this.localListeners.set(rtcSession, set);
    }
    set.add(cb);
    const inbox = this.localInbox.get(rtcSession);
    if (inbox && inbox.length > 0) {
      this.localInbox.delete(rtcSession);
      for (const msg of inbox) cb(msg);
    }
    return () => {
      set?.delete(cb);
    };
  }

  deliverLocal(signal: RtcSignalMessage, sourceNodeId?: string): void {
    if (!this.canCache(signal, sourceNodeId)) return;
    const locals = this.localListeners.get(signal.rtcSession);
    if (locals && locals.size > 0) {
      for (const cb of locals) cb(signal);
      return;
    }
    let inbox = this.localInbox.get(signal.rtcSession);
    if (!inbox) {
      if (this.localInbox.size >= this.maxInboxSessions) return;
      inbox = [];
      this.localInbox.set(signal.rtcSession, inbox);
    }
    if (inbox.length >= this.maxInboxMessages) return;
    inbox.push(signal);
  }

  inboxSize(): number {
    let n = 0;
    for (const inbox of this.localInbox.values()) n += inbox.length;
    return n;
  }

  inboxSessionCount(): number {
    return this.localInbox.size;
  }

  private canCache(signal: RtcSignalMessage, sourceNodeId?: string): boolean {
    this.sweepRemoteOwners();
    if (this.shouldCacheLocal) {
      return this.shouldCacheLocal(signal, sourceNodeId);
    }
    const owner = this.owners.get(signal.rtcSession);
    if (!owner) return false;
    return signal.to.toLowerCase() === this.selfNodeId;
  }

  receiveFromNode(fromNodeId: string, signal: RtcSignalMessage): void {
    this.sweepRemoteOwners();
    const owner = this.owners.get(signal.rtcSession);
    if (!owner) return;
    if (fromNodeId.toLowerCase() !== owner.targetNodeId) return;
    if (signal.from !== 'node') return;
    this.emitBrowser(signal);
  }

  private forwardToNode(nodeId: string, signal: RtcSignalMessage): void {
    if (nodeId === this.selfNodeId) {
      this.deliverLocal(signal);
      return;
    }
    this.sendCtl(nodeId, signal);
  }

  private emitBrowser(signal: RtcSignalMessage): void {
    const sid = this.owners.get(signal.rtcSession)?.browserSessionId;
    if (!sid) return;
    for (const cb of this.subscribers) {
      try {
        cb(signal, sid);
      } catch {
        // subscriber
      }
    }
  }

  private publicOwner(owner: StoredOwner | undefined): RtcSessionOwner | undefined {
    if (!owner) return undefined;
    return { browserSessionId: owner.browserSessionId, targetNodeId: owner.targetNodeId };
  }

  private sweepRemoteOwners(): void {
    const now = this.now();
    for (const [id, owner] of this.owners) {
      if (!this.remoteOwnerExpired(owner, now)) continue;
      this.unregister(id);
    }
  }

  private remoteOwnerExpired(owner: StoredOwner, now: number): boolean {
    if (owner.targetNodeId === this.selfNodeId) return false;
    return now - owner.registeredAt >= this.remoteOwnerTtlMs;
  }
}
