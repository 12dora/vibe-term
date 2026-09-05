import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import type { NodeRegistry } from './node-registry';
import { HUB_RTC_TTL_MS } from './types';
import type { RtcSignalMessage, UplinkCtlMessage } from './uplink-protocol';
import type { LiveConnection } from './uplink-server-state';

export type RegisterRtcSessionInput = {
  userId: string;
  browserSessionId: string;
  fromNodeId: string;
  toNodeId: string;
  ttlMs?: number;
};

export type RtcSessionRegistration = {
  rtcSession: string;
  userId: string;
  browserSessionId: string;
  fromNodeId: string;
  toNodeId: string;
  expiresAt: number;
};

export type UplinkRtcSessionsDeps = {
  send: (link: LinkSession, msg: UplinkCtlMessage) => void;
  forwardRtcAcrossHubs: (live: LiveConnection, msg: RtcSignalMessage) => void;
};

export type UplinkRtcSessionsOptions = {
  userStore: UserStore;
  registry: NodeRegistry;
  now: () => number;
  rtcMaxSessions: number;
  deps: UplinkRtcSessionsDeps;
};

export class UplinkRtcSessions {
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly now: () => number;
  private readonly rtcMaxSessions: number;
  private readonly deps: UplinkRtcSessionsDeps;
  private readonly rtcSessions = new Map<string, RtcSessionRegistration>();

  constructor(opts: UplinkRtcSessionsOptions) {
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.now = opts.now;
    this.rtcMaxSessions = opts.rtcMaxSessions;
    this.deps = opts.deps;
  }

  registerRtcSession(input: RegisterRtcSessionInput): string | null {
    this.sweepRtcSessions();
    if (this.rtcSessions.size >= this.rtcMaxSessions) {
      return null;
    }
    if (!this.rtcNodesOwnedBy(input.userId, input.fromNodeId, input.toNodeId)) {
      return null;
    }
    const rtcSession = encodeBase64url(randomBytes(16));
    const ttlMs = input.ttlMs ?? HUB_RTC_TTL_MS;
    this.rtcSessions.set(rtcSession, {
      rtcSession,
      userId: input.userId,
      browserSessionId: input.browserSessionId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      expiresAt: this.now() + ttlMs,
    });
    return rtcSession;
  }

  unregisterRtcSession(rtcSession: string): void {
    this.rtcSessions.delete(rtcSession);
  }

  ensureDcSession(userId: string, nodeA: string, nodeB: string): boolean {
    const a = nodeA.toLowerCase();
    const b = nodeB.toLowerCase();
    if (!a || !b || a === b) return false;
    if (!this.rtcNodesOwnedBy(userId, a, b)) return false;
    this.sweepRtcSessions();
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const rtcSession = `dc:${lo}:${hi}`;
    const existing = this.rtcSessions.get(rtcSession);
    if (existing) {
      existing.expiresAt = this.now() + HUB_RTC_TTL_MS;
      return true;
    }
    if (this.rtcSessions.size >= this.rtcMaxSessions) return false;
    this.rtcSessions.set(rtcSession, {
      rtcSession,
      userId,
      browserSessionId: '',
      fromNodeId: lo,
      toNodeId: hi,
      expiresAt: this.now() + HUB_RTC_TTL_MS,
    });
    return true;
  }

  handleRtcSignal(live: LiveConnection, msg: RtcSignalMessage): void {
    this.sweepRtcSessions();
    const dc = parseDcPeerSession(msg.rtcSession);
    if (dc) {
      this.forwardDcSignal(live, msg, dc);
      return;
    }
    const reg = this.rtcSessions.get(msg.rtcSession);
    if (reg) {
      if (reg.userId !== live.userId) return;
      if (!this.rtcNodesOwnedBy(reg.userId, reg.fromNodeId, reg.toNodeId)) {
        this.rtcSessions.delete(msg.rtcSession);
        return;
      }
      if (msg.from === 'browser') {
        if (live.nodeId !== reg.fromNodeId || msg.to !== reg.toNodeId) return;
      } else if (msg.from === 'node') {
        if (live.nodeId !== reg.toNodeId || msg.to !== reg.fromNodeId) return;
      } else {
        return;
      }
      const target = this.registry.get(msg.to);
      if (target?.authenticated && target.userId === reg.userId) {
        this.deps.send(target.link, msg);
        return;
      }
      this.deps.forwardRtcAcrossHubs(live, msg);
      return;
    }
    this.deps.forwardRtcAcrossHubs(live, msg);
  }

  private forwardDcSignal(
    live: LiveConnection,
    msg: RtcSignalMessage,
    dc: { a: string; b: string }
  ): void {
    if (!this.rtcNodesOwnedBy(live.userId, dc.a, dc.b)) return;
    if (live.nodeId !== dc.a && live.nodeId !== dc.b) return;
    const other = live.nodeId === dc.a ? dc.b : dc.a;
    if (msg.to !== other) return;
    if (msg.from !== 'node') return;
    this.ensureDcSession(live.userId, dc.a, dc.b);
    const target = this.registry.get(msg.to);
    if (target?.authenticated && target.userId === live.userId) {
      this.deps.send(target.link, msg);
      return;
    }
    this.deps.forwardRtcAcrossHubs(live, msg);
  }

  dropRtcForNode(nodeId: string): void {
    for (const [id, reg] of this.rtcSessions) {
      if (reg.fromNodeId === nodeId || reg.toNodeId === nodeId) {
        this.rtcSessions.delete(id);
      }
    }
  }

  private sweepRtcSessions(): void {
    const now = this.now();
    for (const [id, reg] of this.rtcSessions) {
      if (reg.expiresAt <= now) {
        this.rtcSessions.delete(id);
      }
    }
  }

  private rtcNodesOwnedBy(userId: string, fromNodeId: string, toNodeId: string): boolean {
    const fromCert = this.userStore.getCert(fromNodeId);
    const toCert = this.userStore.getCert(toNodeId);
    if (!fromCert || !toCert) return false;
    if (fromCert.revokedLogSeq !== null || toCert.revokedLogSeq !== null) return false;
    return fromCert.userId === userId && toCert.userId === userId;
  }

  clear(): void {
    this.rtcSessions.clear();
  }
}

function parseDcPeerSession(rtcSession: string): { a: string; b: string } | null {
  if (!rtcSession.startsWith('dc:')) return null;
  const rest = rtcSession.slice(3);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const first = rest.slice(0, idx).toLowerCase();
  const second = rest.slice(idx + 1).toLowerCase();
  if (!first || !second || first === second) return null;
  const a = first < second ? first : second;
  const b = first < second ? second : first;
  return { a, b };
}
