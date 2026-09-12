import type { LinkSession } from '@vibeterm/shared/link';
import {
  DC_REROLL_CAP,
  DC_REROLL_MAX_PER_HOUR,
  DC_REROLL_REHOME_GAIN,
  DC_REROLL_RESULT_DEADLINE_MS,
  DC_REROLL_RESULT_SAMPLES,
  DC_REROLL_WINDOW_MS,
  decideDcReroll,
} from './dc-reroll-policy';
import type { RtcSignalMessage } from './mesh-deps';
import { logLine } from './mesh-log';
import { type PeerManagerState, RTC_PEER_INBOX_MAX_MESSAGES } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { decodeSdpSignal } from './rtc/ice';
import { rtcLog } from './rtc/rtc-log';

export type DcRerollRecord = {
  count: number;
  windowStartedAt: number;
  lastAt: number | null;
  /** 触发时旧链路的稳态 RTT；结算 reroll_result 用。 */
  oldMs: number | null;
  /** 触发时的旧 session：新 session 换上来才说明重掷成功。 */
  prevSession: LinkSession | null;
};

export type DcRerollDeps = {
  breakerAllows: (nodeId: string) => boolean;
  hasDcInflight: (nodeId: string) => boolean;
  /** 绕过 wantsUpgrade / aboveDc 的 DC 拨号；`answer` 为应答侧。 */
  dialReroll: (nodeId: string, opts: { answer: boolean }) => Promise<LinkSession | null>;
  finishRetire: (live: LivePeer, reason: string) => void;
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
 * DC 重掷的触发、应答与结算。挂在 PeerManager 上，被三处调用：
 * live 链路每个 pong（采样 + 判定）、`link.hello` 的能力位、收到对端 rtc 信令。
 */
export class DcRerollCoordinator {
  private readonly state: PeerManagerState;
  private readonly deps: DcRerollDeps;

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
    if (!dcRerollEnabled() || this.deps.hasDcInflight(live.peerNodeId)) return;
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
      isOfferer: this.state.identity.nodeId.toLowerCase() < live.peerNodeId.toLowerCase(),
      breakerAllows: this.deps.breakerAllows(live.peerNodeId),
      now,
    });
    if (decision.reroll) this.start(live, rec, decision.currentMs, decision.bestMs, now);
  }

  /**
   * 手动重掷：跳过 RTT 阈值，其余门（dcInflight / offerer / quiesce / 对端能力 / 熔断 / 预算）照旧。
   * 用于诊断与测试，走的是与自动触发完全相同的拨号与换链路径。
   */
  forceReroll(nodeId: string): boolean {
    if (!dcRerollEnabled()) return false;
    const live = this.state.live.get(nodeId);
    if (!live || live.transport !== 'dc') return false;
    if (!live.quiesceCapable || live.rerollCapable !== true) return false;
    if (this.deps.hasDcInflight(nodeId)) return false;
    if (this.state.identity.nodeId.toLowerCase() >= nodeId.toLowerCase()) return false;
    if (!this.deps.breakerAllows(nodeId)) return false;
    const now = this.state.scheduler.now();
    const rec = this.recordOf(nodeId, now);
    if (rec.count >= DC_REROLL_MAX_PER_HOUR) return false;
    this.start(live, rec, live.rttMs ?? 0, this.state.pathRtt.bestMs(nodeId) ?? 0, now);
    return true;
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
    if (decodeSdpSignal(msg.sdp)?.type !== 'offer') return false;
    if (this.deps.hasDcInflight(nodeId)) return false;
    const now = this.state.scheduler.now();
    const rec = this.recordOf(nodeId, now);
    if (rec.count >= DC_REROLL_MAX_PER_HOUR) return false;
    const inbox = this.state.rtcInbox.get(nodeId) ?? [];
    if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return false;
    rec.count += 1;
    rec.lastAt = now;
    inbox.push({ message: msg, receivedAt: now });
    this.state.rtcInbox.set(nodeId, inbox);
    void this.deps.dialReroll(nodeId, { answer: true }).catch(() => undefined);
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
    now: number
  ): void {
    rec.count += 1;
    rec.lastAt = now;
    rec.oldMs = currentMs;
    rec.prevSession = live.session;
    const nodeId = live.peerNodeId;
    rtcLog('reroll', {
      peer: id8(nodeId),
      reason: 'slow-path',
      cur_ms: round(currentMs),
      best_ms: round(bestMs),
      try: `${rec.count}/${DC_REROLL_MAX_PER_HOUR}`,
    });
    void this.deps
      .dialReroll(nodeId, { answer: false })
      .then((session) => {
        if (!session) this.clearPending(nodeId);
      })
      .catch(() => this.clearPending(nodeId));
  }

  /** 拨失败：旧链路原样留着，预算已经记过，不再等新链路结算。 */
  private clearPending(nodeId: string): void {
    const rec = this.state.rerolls.get(nodeId);
    if (!rec) return;
    rec.oldMs = null;
    rec.prevSession = null;
  }

  private settleResult(live: LivePeer): void {
    const rec = this.state.rerolls.get(live.peerNodeId);
    if (!rec?.prevSession || rec.oldMs == null || rec.lastAt == null) return;
    // 超时未换上新链路：这一轮不再结算，免得把之后某条无关的 dc 当成重掷成果。
    if (this.state.scheduler.now() - rec.lastAt > DC_REROLL_RESULT_DEADLINE_MS) {
      this.clearPending(live.peerNodeId);
      return;
    }
    if (live.transport !== 'dc' || live.session === rec.prevSession) return;
    if (live.linkSinceAt < rec.lastAt || live.rttSamples < DC_REROLL_RESULT_SAMPLES) return;
    const oldMs = rec.oldMs;
    const newMs = live.rttMs ?? oldMs;
    const prevSession = rec.prevSession;
    rec.oldMs = null;
    rec.prevSession = null;
    const gain = oldMs > 0 ? (oldMs - newMs) / oldMs : 0;
    rtcLog('reroll_result', {
      peer: id8(live.peerNodeId),
      old_ms: round(oldMs),
      new_ms: round(newMs),
      better: newMs < oldMs,
    });
    if (gain >= DC_REROLL_REHOME_GAIN) this.rehome(live.peerNodeId, prevSession, gain);
  }

  /**
   * 新链路确实更快时把旧链路上的在途流搬过去：用 `retired` 关旧 session，
   * 转发层的 failover 会在当前 live 上重开流并按 canonical 回放，hub/relay 侧不会 abortBoth。
   */
  private rehome(nodeId: string, prevSession: LinkSession, gain: number): void {
    const set = this.state.retiring.get(nodeId);
    if (!set) return;
    for (const row of [...set]) {
      if (row.session !== prevSession || row.streams === 0) continue;
      rtcLog('reroll_rehome', {
        peer: id8(nodeId),
        streams: row.streams,
        gain_pct: Math.round(gain * 100),
      });
      this.deps.finishRetire(row, 'retired');
    }
  }
}
