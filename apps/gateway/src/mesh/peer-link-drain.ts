import type { LinkSession } from '@tmex/shared/link';
import {
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  type PeerManagerState,
  isPeerTrusted,
} from './peer-manager-state';
import type { ParkedInbound } from './peer-manager-types';
import { type LivePeer, isDrainRetireReason } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import type { PeerTransportKind } from './types';

export type PeerLinkDrainDeps = {
  clearIdle: (live: LivePeer) => void;
  sendPeerCtl: (live: LivePeer, msg: Record<string, unknown>) => void;
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
  armDcUpgradeRetry: (nodeId: string) => void;
  onPeerReconnected: (nodeId: string) => void;
  hasCoalescedUpgrade: (nodeId: string) => boolean;
  track: (
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable?: boolean,
    remoteAddress?: string | null,
    dcAttemptId?: string | null
  ) => LinkSession | null;
};

/**
 * 非当前链路的生命周期：退役中（retiring，排空在途流后关闭）与暂存（parked，等当前链路让位），
 * 连同为二者服务的 quiesce 能力协商（link.hello / link.quiesce.probe）。
 */
export class PeerLinkDrain {
  private readonly state: PeerManagerState;
  private readonly deps: PeerLinkDrainDeps;
  private readonly parkedSessions = new WeakSet<LinkSession>();

  constructor(state: PeerManagerState, deps: PeerLinkDrainDeps) {
    this.state = state;
    this.deps = deps;
  }

  parkInbound(
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress: string | null
  ): void {
    const { parked, scheduler } = this.state;
    const existing = parked.get(peerNodeId);
    const parkedAt = existing?.at ?? scheduler.now();
    if (existing) {
      parked.delete(peerNodeId);
      existing.timer?.clear();
      this.parkedSessions.delete(existing.session);
      quiet(() => existing.session.close('replaced-park'));
    }
    this.armParkedDrain(session);
    this.parkedSessions.add(session);
    const row: ParkedInbound = {
      session,
      transport,
      initiatedBy,
      generation: gen,
      at: parkedAt,
      timer: null,
      remoteAddress,
    };
    row.timer = scheduler.interval(
      () => {
        if (parked.get(peerNodeId) !== row) return;
        if (scheduler.now() - row.at >= PEER_RETIRE_MAX_MS) {
          this.dropParked(peerNodeId, 'park-timeout');
        }
      },
      Math.max(1, PEER_RETIRE_MAX_MS - (scheduler.now() - parkedAt))
    );
    void session.closed.then(() => {
      const cur = parked.get(peerNodeId);
      if (cur?.session === session) {
        cur.timer?.clear();
        this.parkedSessions.delete(session);
        parked.delete(peerNodeId);
      }
    });
    parked.set(peerNodeId, row);
  }

  private armParkedDrain(session: LinkSession): void {
    session.onStream((stream) => {
      if (!this.parkedSessions.has(session)) return;
      quiet(() => stream.reset('parked'));
    });
    session.ctl.onMessage(() => {
      // drain ctl while parked so the inbox cannot grow
    });
  }

  dropParked(nodeId: string, reason: string): void {
    const parked = this.state.parked.get(nodeId);
    if (!parked) return;
    this.state.parked.delete(nodeId);
    parked.timer?.clear();
    this.parkedSessions.delete(parked.session);
    quiet(() => parked.session.close(reason));
  }

  activateParked(nodeId: string): void {
    const parked = this.state.parked.get(nodeId);
    if (!parked) return;
    if (!isPeerTrusted(this.state, nodeId)) {
      this.dropParked(nodeId, 'not-trusted');
      return;
    }
    this.state.parked.delete(nodeId);
    parked.timer?.clear();
    this.parkedSessions.delete(parked.session);
    this.deps.track(
      parked.session,
      nodeId,
      parked.transport,
      parked.initiatedBy,
      parked.generation,
      false,
      parked.remoteAddress
    );
  }

  retirePeer(prev: LivePeer, reason: string): void {
    if (this.state.live.get(prev.peerNodeId) === prev) {
      this.state.live.delete(prev.peerNodeId);
    }
    this.deps.clearIdle(prev);
    prev.pingTimer?.clear();
    prev.pingTimer = null;
    if (prev.finishRetired) {
      this.finishRetire(prev, reason);
      return;
    }
    prev.retiring = true;
    prev.retireReason = reason;
    prev.retiredAt = this.state.scheduler.now();
    prev.zeroStreamsSince = prev.streams === 0 ? prev.retiredAt : 0;
    let set = this.state.retiring.get(prev.peerNodeId);
    if (!set) {
      set = new Set();
      this.state.retiring.set(prev.peerNodeId, set);
    }
    set.add(prev);
    this.restartQuiesce(prev);
    this.armRetireTimer(prev, reason);
    this.maybeFinishRetire(prev, reason);
  }

  private nextRetireDelayMs(live: LivePeer): number {
    const now = this.state.scheduler.now();
    let due = live.retiredAt + PEER_RETIRE_MAX_MS;
    if (live.streams === 0 && live.zeroStreamsSince > 0) {
      due = Math.min(
        due,
        Math.max(live.retiredAt + PEER_RETIRE_MIN_MS, live.zeroStreamsSince + PEER_RETIRE_QUIET_MS)
      );
    }
    return Math.max(1, due - now);
  }

  armRetireTimer(live: LivePeer, reason = live.retireReason): void {
    live.retireTimer?.clear();
    live.retireTimer = null;
    if (!live.retiring || live.finishRetired) return;
    live.retireTimer = this.state.scheduler.interval(() => {
      this.maybeFinishRetire(live, reason);
    }, this.nextRetireDelayMs(live));
  }

  maybeFinishRetire(live: LivePeer, reason = live.retireReason): void {
    if (!live.retiring || live.finishRetired) return;
    const now = this.state.scheduler.now();
    const elapsed = now - live.retiredAt;
    // 心跳失活/闲置退役的连接已经不再收发心跳，在途流不能无限期挂着，硬截止先于流数判断。
    if (isDrainRetireReason(live.retireReason) && elapsed >= PEER_RETIRE_MAX_MS) {
      this.finishRetire(live, reason);
      return;
    }
    if (live.streams > 0) return;
    const quietFor = live.zeroStreamsSince > 0 ? now - live.zeroStreamsSince : 0;
    if (
      (live.gotQuiesceAck && live.gotPeerQuiesce) ||
      elapsed >= PEER_RETIRE_MAX_MS ||
      (elapsed >= PEER_RETIRE_MIN_MS && quietFor >= PEER_RETIRE_QUIET_MS)
    ) {
      this.finishRetire(live, reason);
    }
  }

  finishRetire(live: LivePeer, reason = live.retireReason): void {
    if (live.finishRetired) {
      quiet(() => live.session.close(reason));
      return;
    }
    live.finishRetired = true;
    live.retiring = false;
    live.retireTimer?.clear();
    live.retireTimer = null;
    if (live.unsubRtc) {
      live.unsubRtc();
      live.unsubRtc = null;
    }
    this.state.rtcInbox.delete(live.peerNodeId);
    const set = this.state.retiring.get(live.peerNodeId);
    if (set) {
      set.delete(live);
      if (set.size === 0) this.state.retiring.delete(live.peerNodeId);
    }
    this.deps.clearIdle(live);
    live.pingTimer?.clear();
    live.pingTimer = null;
    quiet(() => live.session.close(reason));
  }

  forceCloseRetiring(nodeId: string, reason: string): void {
    const set = this.state.retiring.get(nodeId);
    if (!set) return;
    this.state.retiring.delete(nodeId);
    for (const live of set) {
      live.retiring = false;
      this.finishRetire(live, reason);
    }
  }

  restartQuiesce(live: LivePeer): void {
    live.gotQuiesceAck = false;
    live.gotPeerQuiesce = false;
    this.deps.sendPeerCtl(live, { t: 'link.quiesce' });
  }

  sendLinkHello(live: LivePeer): void {
    this.deps.sendPeerCtl(live, { t: 'link.hello', caps: ['quiesce'] });
  }

  probeQuiesce(live: LivePeer): void {
    if (live.probeSent || live.quiesceCapable) return;
    live.probeSent = true;
    this.deps.sendPeerCtl(live, { t: 'link.quiesce.probe' });
  }

  markQuiesceCapable(live: LivePeer): void {
    const already = live.quiesceCapable;
    live.quiesceCapable = true;
    if (already || live.retiring) return;
    this.activateParked(live.peerNodeId);
    const current = this.state.live.get(live.peerNodeId);
    this.state.peerReconnectWake.ready(current, (nodeId) => this.deps.onPeerReconnected(nodeId));
    if (this.deps.hasCoalescedUpgrade(live.peerNodeId)) {
      this.deps.maybeUpgrade(live.peerNodeId, { cooldown: true });
    }
    if (this.state.lostDirect.has(live.peerNodeId)) {
      this.deps.armDcUpgradeRetry(live.peerNodeId);
    }
  }
}
