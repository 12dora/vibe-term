import type { LinkSession } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import {
  DC_REROLL_CAP,
  DC_REROLL_MAX_PER_HOUR,
  DC_REROLL_MIN_INTERVAL_MS,
  DC_REROLL_REHOME_GAIN,
  DC_REROLL_RESULT_DEADLINE_MS,
  DC_REROLL_RESULT_SAMPLES,
  DC_REROLL_WINDOW_MS,
  type DirectRerollTransport,
  decideDcReroll,
} from './dc-reroll-policy';
import type { RtcSignalMessage } from './mesh-deps';
import { logLine } from './mesh-log';
import { winningDialInitiator } from './peer-direct-attempt';
import { type PeerManagerState, RTC_PEER_INBOX_MAX_MESSAGES } from './peer-manager-state';
import { PEER_LINK_REROLL_REQUEST, parseLinkRerollRequest } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { RTC_SIGNAL_INBOX_TTL_MS, type RtcSignalInboxEntry } from './peer-rtc-wake';
import { decodeCandidateSignal, decodeSdpSignal } from './rtc/ice';
import { rtcLog } from './rtc/rtc-log';

/** 候选在 rtcInbox 里最多占的条数（总上限 RTC_PEER_INBOX_MAX_MESSAGES=32），其余留给 offer。 */
export const DC_REROLL_CANDIDATE_INBOX_CAP = 16;

export type DcRerollRecord = {
  count: number;
  windowStartedAt: number;
  lastAt: number | null;
  /** 触发时旧链路的稳态 RTT；结算 reroll_result 用。 */
  oldMs: number | null;
  /** 触发时的旧 session：新 session 换上来才说明重掷成功。 */
  prevSession: LinkSession | null;
  /** 触发时的 transport；结算必须对上，避免把无关的 dc/ws 当成这一轮成果。 */
  transport: DirectRerollTransport | null;
  /** 本端刚发出 reroll-request，对端随后的 offer 不再二次记预算。 */
  pendingPeerRequest?: boolean;
};

export type DirectRerollOpts = { answer: boolean; transport?: DirectRerollTransport };

export type DcRerollDeps = {
  breakerAllows: (nodeId: string) => boolean;
  hasDcInflight: (nodeId: string) => boolean;
  hasWsRerollInflight?: (nodeId: string) => boolean;
  dcCapable?: (nodeId: string) => boolean;
  /** 升级协调器：下一次扫描会拨这个对端（已 coalesced / scheduled）。 */
  willAttemptUpgrade?: (nodeId: string) => boolean;
  /** 绕过 wantsUpgrade / aboveDc 的直连拨号；`answer` 仅 DC 应答侧使用。 */
  dialReroll: (nodeId: string, opts: DirectRerollOpts) => Promise<LinkSession | null>;
  finishRetire: (live: LivePeer, reason: string) => void;
  /** 应答侧发 `link.reroll-request`；测试可注入。缺省走 session.ctl。 */
  sendPeerCtl?: (live: LivePeer, msg: Record<string, unknown>) => void;
};

let disabledLogged = false;

/** 关掉之后本端既不触发重掷，也不在 link.hello 里报 reroll 能力，对端因此也不会来拨。 */
export function dcRerollEnabled(): boolean {
  const enabled = process.env.VIBETERM_DC_REROLL?.trim().toLowerCase() !== 'off';
  if (!enabled && !disabledLogged) {
    disabledLogged = true;
    logLine('[mesh][rtc]', 'dc reroll disabled by VIBETERM_DC_REROLL=off');
  }
  return enabled;
}

export function resetDcRerollEnvLogForTest(): void {
  disabledLogged = false;
}

function id8(nodeId: string): string {
  return nodeId.slice(0, 8);
}

function round(ms: number): number {
  return Math.round(ms);
}

/**
 * 直连重掷的触发、应答与结算。挂在 PeerManager 上，被三处调用：
 * live 链路每个 pong（采样 + 判定）、`link.hello` 的能力位、收到对端 rtc 信令。
 */
export class DcRerollCoordinator {
  private readonly state: PeerManagerState;
  private readonly deps: DcRerollDeps;
  /** 入站 `link.reroll-request` 每对端 60 s 至多处理一条，不论是否通过校验。 */
  private readonly inboundRequestAt = new Map<string, number>();

  constructor(state: PeerManagerState, deps: DcRerollDeps) {
    this.state = state;
    this.deps = deps;
  }

  /** 本端要不要在 link.hello 里报 reroll 能力。 */
  helloCaps(): string[] {
    return dcRerollEnabled() ? [DC_REROLL_CAP] : [];
  }

  noteHelloCaps(live: LivePeer, caps: readonly unknown[]): void {
    if (caps.includes(DC_REROLL_CAP)) live.rerollCapable = true;
  }

  /** 每个 pong：写路径 RTT 记忆 → 结算上一次重掷 → 判定是否再掷。 */
  onRttSample(live: LivePeer, sampleMs: number): void {
    live.rttSamples += 1;
    if (live.transport === 'dc' || live.transport === 'ws-secure') {
      this.state.pathRtt.record(live.peerNodeId, { kind: live.transport, rttMs: sampleMs });
    }
    this.settleResult(live);
    if (!dcRerollEnabled() || this.busy(live.peerNodeId)) return;
    const now = this.state.scheduler.now();
    const rec = this.recordOf(live.peerNodeId, now);
    const decision = decideDcReroll({
      transport: live.transport,
      rttMs: live.rttMs,
      samples: live.rttSamples,
      linkAgeMs: now - live.linkSinceAt,
      bestKnownMs: this.state.pathRtt.bestMs(live.peerNodeId),
      rerolls: rec,
      lastRerollAt: rec.lastAt,
      quiesceCapable: live.quiesceCapable,
      peerCapable: live.rerollCapable === true,
      isOfferer: this.isInitiator(live.peerNodeId),
      canRequest: live.rerollCapable === true,
      breakerAllows: this.deps.breakerAllows(live.peerNodeId),
      dcUpgradePending: this.dcUpgradePending(live),
      now,
    });
    if (!decision.reroll) return;
    if (this.isInitiator(live.peerNodeId)) {
      this.start(live, rec, decision.currentMs, decision.bestMs, now);
    } else {
      this.requestReroll(live, rec, decision.currentMs, decision.bestMs, now);
    }
  }

  /**
   * 手动重掷：跳过 RTT 阈值，其余门（inflight / initiator / quiesce / 对端能力 / 熔断 / 预算）照旧。
   * 用于诊断与测试，走的是与自动触发完全相同的拨号与换链路径。DC 与 ws-secure 都认。
   */
  forceReroll(nodeId: string): boolean {
    if (!dcRerollEnabled()) return false;
    const live = this.state.live.get(nodeId);
    if (!this.canForce(live)) return false;
    const now = this.state.scheduler.now();
    const rec = this.recordOf(nodeId, now);
    if (rec.count >= DC_REROLL_MAX_PER_HOUR) return false;
    this.start(live, rec, live.rttMs ?? 0, this.state.pathRtt.bestMs(nodeId) ?? 0, now);
    return true;
  }

  /**
   * 入站 `link.reroll-request`：先按对端 60 s 限流（不论校验成败），再走 forceReroll 同款门闩。
   * 通过则 `reason=peer-request` 起拨；否则 debug 丢掉。
   */
  handlePeerRequest(live: LivePeer, msg: Record<string, unknown>): void {
    if (!dcRerollEnabled()) return;
    const now = this.state.scheduler.now();
    const nodeId = live.peerNodeId;
    const prevAt = this.inboundRequestAt.get(nodeId);
    if (prevAt != null && now - prevAt < DC_REROLL_MIN_INTERVAL_MS) {
      rtcLog('reroll_request_ignored', { peer: id8(nodeId), reason: 'rate' });
      return;
    }
    this.inboundRequestAt.set(nodeId, now);
    const parsed = parseLinkRerollRequest(msg);
    const reason = this.peerRequestRejectReason(live, parsed, now);
    if (reason || !parsed) {
      rtcLog('reroll_request_ignored', { peer: id8(nodeId), reason: reason ?? 'malformed' });
      return;
    }
    this.start(
      live,
      this.recordOf(nodeId, now),
      parsed.currentMs,
      parsed.bestMs,
      now,
      'peer-request'
    );
  }

  /** `receiveRtcSignal` 用：offer 与提前到达的 ICE 候选都在这里接管。 */
  interceptRtc(nodeId: string, msg: RtcSignalMessage): boolean {
    return this.interceptOffer(nodeId, msg) || this.interceptCandidate(nodeId, msg);
  }

  /**
   * 应答侧入口：已是 dc 时常规路径不会再建 PC（`wantsUpgrade` 为 false、`aboveDc` 不成立），
   * 重掷 offer 因此必须在这里单独接住——入队后直接起应答拨号。只接对端在 `link.hello` 里
   * 报过 reroll 能力的 offer（2.3.1 及更早不会发重掷 offer），并同样受每小时 3 次的预算约束。
   * 调用方必须先把消息投给现有监听者，让旧 attempt 的残留监听自行 superseded 退订。
   */
  interceptOffer(nodeId: string, msg: RtcSignalMessage): boolean {
    if (!dcRerollEnabled() || !msg.sdp) return false;
    const live = this.state.live.get(nodeId);
    if (!live || live.transport !== 'dc' || live.rerollCapable !== true) return false;
    const offer = decodeSdpSignal(msg.sdp);
    if (offer?.type !== 'offer') return false;
    // 旧 attempt 的迟到 offer（epoch 不高于当前 live）不是重掷，不能耗预算、不能起 attempt。
    if (live.rtcEpoch !== undefined && offer.epoch !== undefined && offer.epoch <= live.rtcEpoch) {
      return false;
    }
    if (this.deps.hasDcInflight(nodeId)) return false;
    const now = this.state.scheduler.now();
    const rec = this.recordOf(nodeId, now);
    if (!this.canAcceptRerollOffer(rec, now)) return false;
    if (offer.epoch !== undefined) this.dropForeignCandidates(nodeId, offer.epoch);
    if (!this.enqueueInbox(nodeId, msg)) return false;
    this.noteRerollOfferAccepted(rec, now);
    void this.deps.dialReroll(nodeId, { answer: true, transport: 'dc' }).catch(() => undefined);
    return true;
  }

  /**
   * 新 epoch 的 ICE 候选可能先于 offer 到达。旧 live 监听会把它丢掉但 `delivered`
   * 仍为 true，这里另写入 inbox，留给随后 interceptOffer 起的应答 attempt drain。
   * live.rtcEpoch 缺省时：候选带 epoch，且 inbox 里还没有该 epoch 的 offer。
   */
  interceptCandidate(nodeId: string, msg: RtcSignalMessage): boolean {
    if (!dcRerollEnabled() || !msg.candidate || msg.sdp) return false;
    const live = this.state.live.get(nodeId);
    if (!live || live.transport !== 'dc' || live.rerollCapable !== true) return false;
    if (this.deps.hasDcInflight(nodeId)) return false;
    const decoded = decodeCandidateSignal(msg.candidate);
    if (!decoded || decoded.epoch === undefined) return false;
    const inbox = this.prunedInbox(nodeId);
    if (!this.candidateEpochEligible(live, decoded.epoch, inbox)) return false;
    // 候选只能占 inbox 的一部分，给随后到达的 offer 留位置；否则迟到/重放候选会把 offer 挤出去。
    if (inbox.filter((entry) => !entry.message.sdp).length >= DC_REROLL_CANDIDATE_INBOX_CAP) {
      return false;
    }
    if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return false;
    inbox.push({ message: msg, receivedAt: this.state.scheduler.now() });
    this.state.rtcInbox.set(nodeId, inbox);
    return true;
  }

  /** 预算记录按滚动窗口就地重置：窗口过期先归零再累加。 */
  private recordOf(nodeId: string, now: number): DcRerollRecord {
    const prev = this.state.rerolls.get(nodeId);
    if (!prev) {
      const fresh: DcRerollRecord = {
        count: 0,
        windowStartedAt: now,
        lastAt: null,
        oldMs: null,
        prevSession: null,
        transport: null,
        pendingPeerRequest: false,
      };
      this.state.rerolls.set(nodeId, fresh);
      return fresh;
    }
    if (now - prev.windowStartedAt >= DC_REROLL_WINDOW_MS) {
      prev.count = 0;
      prev.windowStartedAt = now;
    }
    return prev;
  }

  private start(
    live: LivePeer,
    rec: DcRerollRecord,
    currentMs: number,
    bestMs: number,
    now: number,
    reason: 'slow-path' | 'peer-request' = 'slow-path'
  ): void {
    const transport: DirectRerollTransport = live.transport === 'ws-secure' ? 'ws-secure' : 'dc';
    rec.count += 1;
    rec.lastAt = now;
    rec.oldMs = currentMs;
    rec.prevSession = live.session;
    rec.transport = transport;
    const nodeId = live.peerNodeId;
    rtcLog('reroll', {
      peer: id8(nodeId),
      transport,
      reason,
      cur_ms: round(currentMs),
      best_ms: round(bestMs),
      try: `${rec.count}/${DC_REROLL_MAX_PER_HOUR}`,
    });
    void this.deps
      .dialReroll(nodeId, { answer: false, transport })
      .then((session) => {
        if (!session) this.clearPending(nodeId);
      })
      .catch(() => this.clearPending(nodeId));
  }

  private requestReroll(
    live: LivePeer,
    rec: DcRerollRecord,
    currentMs: number,
    bestMs: number,
    now: number
  ): void {
    const transport: DirectRerollTransport = live.transport === 'ws-secure' ? 'ws-secure' : 'dc';
    rec.count += 1;
    rec.lastAt = now;
    rec.pendingPeerRequest = true;
    rtcLog('reroll_request', {
      peer: id8(live.peerNodeId),
      transport,
      cur_ms: round(currentMs),
      best_ms: round(bestMs),
      try: `${rec.count}/${DC_REROLL_MAX_PER_HOUR}`,
    });
    this.emitCtl(live, {
      t: PEER_LINK_REROLL_REQUEST,
      transport,
      currentMs,
      bestMs,
    });
  }

  private emitCtl(live: LivePeer, msg: Record<string, unknown>): void {
    if (this.deps.sendPeerCtl) {
      this.deps.sendPeerCtl(live, msg);
      return;
    }
    try {
      void Promise.resolve(live.session.ctl.send(encodeJsonBytes(msg))).catch(() => undefined);
    } catch {
      // 对端已关
    }
  }

  private peerRequestRejectReason(
    live: LivePeer,
    parsed: ReturnType<typeof parseLinkRerollRequest>,
    now: number
  ): string | null {
    if (!parsed) return 'malformed';
    if (this.state.live.get(live.peerNodeId) !== live) return 'not-live';
    if (parsed.transport !== live.transport) return 'transport';
    if (!this.isInitiator(live.peerNodeId)) return 'not-offerer';
    if (!live.quiesceCapable) return 'quiesce';
    if (this.busy(live.peerNodeId)) return 'inflight';
    if (live.transport === 'dc') {
      if (live.rerollCapable !== true) return 'peer-cap';
      if (!this.deps.breakerAllows(live.peerNodeId)) return 'breaker';
    } else if (this.dcUpgradePending(live)) {
      return 'dc-upgrade';
    }
    const rec = this.recordOf(live.peerNodeId, now);
    if (rec.count >= DC_REROLL_MAX_PER_HOUR) return 'budget';
    if (rec.lastAt != null && now - rec.lastAt < DC_REROLL_MIN_INTERVAL_MS) return 'cooldown';
    return null;
  }

  private isAnsweringOwnRequest(rec: DcRerollRecord, now: number): boolean {
    return (
      rec.pendingPeerRequest === true &&
      rec.lastAt != null &&
      now - rec.lastAt < DC_REROLL_RESULT_DEADLINE_MS
    );
  }

  private canAcceptRerollOffer(rec: DcRerollRecord, now: number): boolean {
    return this.isAnsweringOwnRequest(rec, now) || rec.count < DC_REROLL_MAX_PER_HOUR;
  }

  private noteRerollOfferAccepted(rec: DcRerollRecord, now: number): void {
    const answeringOwn = this.isAnsweringOwnRequest(rec, now);
    rec.pendingPeerRequest = false;
    if (answeringOwn) return;
    rec.count += 1;
    rec.lastAt = now;
  }

  /** 拨失败：旧链路原样留着，预算已经记过，不再等新链路结算。 */
  private clearPending(nodeId: string): void {
    const rec = this.state.rerolls.get(nodeId);
    if (!rec) return;
    rec.oldMs = null;
    rec.prevSession = null;
    rec.transport = null;
  }

  private settleResult(live: LivePeer): void {
    const rec = this.state.rerolls.get(live.peerNodeId);
    if (!rec?.prevSession || rec.oldMs == null || rec.lastAt == null || !rec.transport) return;
    // 超时未换上新链路：这一轮不再结算，免得把之后某条无关的链路当成重掷成果。
    if (this.state.scheduler.now() - rec.lastAt > DC_REROLL_RESULT_DEADLINE_MS) {
      this.clearPending(live.peerNodeId);
      return;
    }
    if (live.transport !== rec.transport || live.session === rec.prevSession) return;
    if (live.linkSinceAt < rec.lastAt || live.rttSamples < DC_REROLL_RESULT_SAMPLES) return;
    const oldMs = rec.oldMs;
    const newMs = live.rttMs ?? oldMs;
    const prevSession = rec.prevSession;
    const transport = rec.transport;
    rec.oldMs = null;
    rec.prevSession = null;
    rec.transport = null;
    const gain = oldMs > 0 ? (oldMs - newMs) / oldMs : 0;
    rtcLog('reroll_result', {
      peer: id8(live.peerNodeId),
      transport,
      old_ms: round(oldMs),
      new_ms: round(newMs),
      better: newMs < oldMs,
    });
    if (gain >= DC_REROLL_REHOME_GAIN) this.rehome(live.peerNodeId, prevSession, gain, transport);
  }

  /**
   * 新链路确实更快时把旧链路上的在途流搬过去：用 `retired` 关旧 session，
   * 转发层的 failover 会在当前 live 上重开流并按 canonical 回放，hub/relay 侧不会 abortBoth。
   */
  private rehome(
    nodeId: string,
    prevSession: LinkSession,
    gain: number,
    transport: DirectRerollTransport
  ): void {
    const set = this.state.retiring.get(nodeId);
    if (!set) return;
    for (const row of [...set]) {
      if (row.session !== prevSession || row.streams === 0) continue;
      rtcLog('reroll_rehome', {
        peer: id8(nodeId),
        transport,
        streams: row.streams,
        gain_pct: Math.round(gain * 100),
      });
      this.deps.finishRetire(row, 'retired');
    }
  }

  private busy(nodeId: string): boolean {
    return this.deps.hasDcInflight(nodeId) || this.deps.hasWsRerollInflight?.(nodeId) === true;
  }

  private isInitiator(nodeId: string): boolean {
    return winningDialInitiator(this.state.identity.nodeId, nodeId) === this.state.identity.nodeId;
  }

  private dcUpgradePending(live: LivePeer): boolean {
    if (live.transport !== 'ws-secure' || this.deps.dcCapable?.(live.peerNodeId) !== true) {
      return false;
    }
    const nodeId = live.peerNodeId;
    return (
      this.deps.hasDcInflight(nodeId) ||
      this.state.upgrading.has(nodeId) ||
      this.deps.willAttemptUpgrade?.(nodeId) === true
    );
  }

  private candidateEpochEligible(
    live: LivePeer,
    epoch: number,
    inbox: RtcSignalInboxEntry[]
  ): boolean {
    if (live.rtcEpoch !== undefined) return epoch > live.rtcEpoch;
    return !inbox.some((entry) => decodeSdpSignal(entry.message.sdp ?? '')?.epoch === epoch);
  }

  /** offer 落定 epoch 后，把之前按 fallback 入队、epoch 对不上的候选清掉。 */
  private dropForeignCandidates(nodeId: string, epoch: number): void {
    const inbox = this.prunedInbox(nodeId).filter((entry) => {
      if (entry.message.sdp || !entry.message.candidate) return true;
      return decodeCandidateSignal(entry.message.candidate)?.epoch === epoch;
    });
    if (inbox.length === 0) this.state.rtcInbox.delete(nodeId);
    else this.state.rtcInbox.set(nodeId, inbox);
  }

  private prunedInbox(nodeId: string): RtcSignalInboxEntry[] {
    const cutoff = this.state.scheduler.now() - RTC_SIGNAL_INBOX_TTL_MS;
    const inbox = (this.state.rtcInbox.get(nodeId) ?? []).filter((row) => row.receivedAt >= cutoff);
    if (inbox.length === 0) this.state.rtcInbox.delete(nodeId);
    else this.state.rtcInbox.set(nodeId, inbox);
    return inbox;
  }

  private enqueueInbox(nodeId: string, msg: RtcSignalMessage): boolean {
    const inbox = this.prunedInbox(nodeId);
    if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return false;
    inbox.push({ message: msg, receivedAt: this.state.scheduler.now() });
    this.state.rtcInbox.set(nodeId, inbox);
    return true;
  }

  private canForce(live: LivePeer | undefined): live is LivePeer {
    if (!live) return false;
    if (live.transport !== 'dc' && live.transport !== 'ws-secure') return false;
    if (!live.quiesceCapable || this.busy(live.peerNodeId) || !this.isInitiator(live.peerNodeId)) {
      return false;
    }
    if (live.transport === 'dc') {
      return live.rerollCapable === true && this.deps.breakerAllows(live.peerNodeId);
    }
    return !this.dcUpgradePending(live);
  }
}
