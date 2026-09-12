import type { LinkSession } from '@vibeterm/shared/link';
import { warnLine } from './mesh-log';
import {
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  PEER_RETIRE_STREAM_LEAK_MS,
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
  /** link.hello 里本端要报的额外能力位（目前只有 reroll）。 */
  extraHelloCaps: () => string[];
  /** 对端 link.hello 的能力位。 */
  noteHelloCaps: (live: LivePeer, caps: readonly unknown[]) => void;
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
    if (live.streams > 0) {
      if (isDrainRetireReason(live.retireReason)) {
        return Math.max(1, live.retiredAt + PEER_RETIRE_MAX_MS - now);
      }
      const leakDue = live.retiredAt + PEER_RETIRE_STREAM_LEAK_MS;
      return Math.max(1, Math.min(PEER_RETIRE_QUIET_MS, leakDue - now));
    }
    let due = live.retiredAt + PEER_RETIRE_MAX_MS;
    if (live.zeroStreamsSince > 0) {
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
    // make-before-break：replaced 等有内层流时保持旧 session，按 QUIET 轮询；30 min 泄漏上限才强制 retired。
    if (live.streams > 0) {
      // 严格大于 30 min：与 DC idle（恰好 30 min 时 promote retiring relay）错开同一时刻。
      if (elapsed > PEER_RETIRE_STREAM_LEAK_MS) {
        warnLine(
          '[mesh]',
          `retire leak-guard peer=${live.peerNodeId} streams=${live.streams} elapsed_ms=${elapsed}`
        );
        this.finishRetire(live, 'retired');
      }
      return;
    }
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
    // 仍有内层流时不要用 replaced 关 relay：hub pump 会 abortBoth。
    const closeReason = live.streams > 0 && reason === 'replaced' ? 'retired' : reason;
    quiet(() => live.session.close(closeReason));
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
    this.deps.sendPeerCtl(live, {
      t: 'link.hello',
      caps: ['quiesce', ...this.deps.extraHelloCaps()],
    });
  }

  /** `link.*` 控制消息的统一入口：quiesce 能力协商、退役握手与重掷预告。 */
  handleLinkCtl(live: LivePeer, t: string, msg: Record<string, unknown>): void {
    if (t === 'link.hello') {
      const caps = Array.isArray(msg.caps) ? msg.caps : [];
      this.deps.noteHelloCaps(live, caps);
      if (caps.includes('quiesce')) this.markQuiesceCapable(live);
      if (!live.helloReplied) {
        live.helloReplied = true;
        this.sendLinkHello(live);
      }
      return;
    }
    this.handleQuiesceCtl(live, t);
  }

  private handleQuiesceCtl(live: LivePeer, t: string): void {
    if (t === 'link.quiesce.probe') {
      this.markQuiesceCapable(live);
      this.deps.sendPeerCtl(live, { t: 'link.quiesce.probe.ack' });
      return;
    }
    if (t === 'link.quiesce.probe.ack') {
      this.markQuiesceCapable(live);
      return;
    }
    if (t !== 'link.quiesce' && t !== 'link.quiesce.ack') return;
    if (t === 'link.quiesce') {
      live.gotPeerQuiesce = true;
      this.deps.sendPeerCtl(live, { t: 'link.quiesce.ack' });
    } else live.gotQuiesceAck = true;
    this.markQuiesceCapable(live);
    if (live.retiring) this.maybeFinishRetire(live);
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
