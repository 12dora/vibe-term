import {
  DC_MIN_STABLE_MS,
  DC_UNSTABLE_BACKOFF_CAP_MS,
  DC_UNSTABLE_BACKOFF_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  type PeerManagerState,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { currentDcProofGeneration, dcLinkProven, subscribeDcLinkProof } from './rtc/dc-link-proof';
import {
  RTC_DIAL_BREAKER_HEALTHY_MS,
  classifyRtcDialFailure,
  isIntentionalDcLoss,
} from './rtc/rtc-dial-breaker';
import { rtcLog } from './rtc/rtc-log';

/** link.hello 能力位：对端会把中继留到 DC 稳住，并按短命夭折升级冷却。2.9.0 起广告。 */
export const DC_STABLE_HOLD_CAP = 'dc-stable-hold';

const stableHoldPeers = new Set<string>();

export function notePeerDcStableHold(peerId: string): void {
  stableHoldPeers.add(peerId);
}

export function peerSupportsDcStableHold(peerId: string): boolean {
  return stableHoldPeers.has(peerId);
}

export function resetDcStableHoldForTests(): void {
  stableHoldPeers.clear();
}

/**
 * 通道已经建立之后的断开。这是路径/存活损失，不是「拨号没连上」。
 * `dc-promote-reject` 是本端主动拆掉还没证明自己的候选。
 */
const POST_ESTABLISH_DC_LOSS = new Set([
  'channel-closed',
  'liveness-timeout',
  'missed-pong',
  'dc-promote-reject',
]);

type LiveProof = {
  proven: boolean;
  generation?: number;
  unsub?: () => void;
};

const liveProof = new WeakMap<LivePeer, LiveProof>();

function proofRow(live: LivePeer): LiveProof {
  let row = liveProof.get(live);
  if (!row) {
    row = { proven: false };
    liveProof.set(live, row);
  }
  return row;
}

export function isPostEstablishDcLoss(reason: string): boolean {
  return POST_ESTABLISH_DC_LOSS.has(reason);
}

export function markLiveDcProven(live: LivePeer): void {
  proofRow(live).proven = true;
}

export function isLiveDcProven(live: LivePeer): boolean {
  const row = liveProof.get(live);
  if (row?.proven === true) return true;
  return dcLinkProven(live.peerNodeId, row?.generation);
}

export function unbindLiveDcProof(live: LivePeer | undefined): void {
  if (!live) return;
  const row = liveProof.get(live);
  row?.unsub?.();
  if (row) row.unsub = undefined;
}

export function bindLiveDcProof(live: LivePeer, onProven: () => void): void {
  const row = proofRow(live);
  row.unsub?.();
  row.generation = currentDcProofGeneration(live.peerNodeId);
  const fire = () => {
    if (row.proven) return;
    row.proven = true;
    onProven();
  };
  if (dcLinkProven(live.peerNodeId, row.generation)) {
    fire();
    return;
  }
  row.unsub = subscribeDcLinkProof(live.peerNodeId, row.generation, fire);
}

/** mux 入站 ping 或 pong。不写全局 generation，避免旧链的迟到包证明下一条 DC。 */
export function noteLiveDcProof(live: LivePeer, onProven: () => void): void {
  if (live.transport !== 'dc') return;
  const row = proofRow(live);
  if (row.proven) return;
  row.proven = true;
  onProven();
}

/**
 * replaced 掉的 relay/ws 在新 DC 稳住之前不关。稳住 = 对端认 dc-stable-hold，
 * 且本端已证明并活过 DC_MIN_STABLE_MS。对端还在 pending-measure 时同样留着。
 * 在途流仍走原来的排空判断，这里只挡 streams===0 的提前收尾。30s 封顶不变。
 */
export function shouldHoldUnprovenDc(
  state: PeerManagerState,
  retiring: LivePeer,
  elapsed: number
): boolean {
  if (elapsed >= PEER_RETIRE_MAX_MS) return false;
  const next = replacedRelayNextDc(state, retiring);
  if (!next) return false;
  if (remoteMeasureActive(state, next.peerNodeId)) return true;
  if (!peerSupportsDcStableHold(next.peerNodeId)) return false;
  return !dcStableEnough(state, next);
}

function replacedRelayNextDc(state: PeerManagerState, retiring: LivePeer): LivePeer | null {
  if (retiring.retireReason !== 'replaced' || retiring.transport === 'dc') return null;
  const next = state.live.get(retiring.peerNodeId);
  if (!next || next.transport !== 'dc') return null;
  return next;
}

function remoteMeasureActive(state: PeerManagerState, peerId: string): boolean {
  // 截止时间是转发层打的 Date.now()，retire 用的 scheduler 对不上。
  return Date.now() < (state.remoteMeasureUntil.get(peerId) ?? 0);
}

function dcStableEnough(state: PeerManagerState, live: LivePeer): boolean {
  if (!isLiveDcProven(live)) return false;
  return state.scheduler.now() - live.linkSinceAt >= DC_MIN_STABLE_MS;
}

export function shouldFinishReplacedRetire(
  live: LivePeer,
  elapsed: number,
  quietFor: number,
  state: PeerManagerState
): boolean {
  if (shouldHoldUnprovenDc(state, live, elapsed)) return false;
  return (
    (live.gotQuiesceAck && live.gotPeerQuiesce) ||
    elapsed >= PEER_RETIRE_MAX_MS ||
    (elapsed >= PEER_RETIRE_MIN_MS && quietFor >= PEER_RETIRE_QUIET_MS)
  );
}

/** 第 1 次 60s，之后翻倍，封顶 30min。 */
export function unstableCooldownMs(strike: number): number {
  if (strike <= 0) return 0;
  const exp = Math.min(strike - 1, 16);
  return Math.min(DC_UNSTABLE_BACKOFF_MS * 2 ** exp, DC_UNSTABLE_BACKOFF_CAP_MS);
}

export class UnstableDcBackoff {
  private readonly level = new Map<string, number>();

  /**
   * 建连后寿命短于 RTC_DIAL_BREAKER_HEALTHY_MS 记一笔，不论有没有证明过。
   * 返回本次应交给 noteUnstable 的冷却；0 表示这次不冷却。
   * 只有 noteHealthy 清连击。
   */
  noteShortLife(peer: string, lifetimeMs: number): number {
    if (lifetimeMs >= RTC_DIAL_BREAKER_HEALTHY_MS) return 0;
    const next = (this.level.get(peer) ?? 0) + 1;
    this.level.set(peer, next);
    return unstableCooldownMs(next);
  }

  noteHealthy(peer: string): void {
    this.level.delete(peer);
  }

  clearAll(): void {
    this.level.clear();
  }
}

const ROUTE_CLOSE_REASONS = new Set([
  'dc-promote-reject',
  'dc-promote-backoff',
  'route-measure-reject',
  'route-relay',
]);
export const ROUTE_CLOSE_DEFAULT_MS = 60_000;

const routeCloseByLive = new WeakMap<LivePeer, { until: number }>();

/** 已建立 DC 上的选路关闭。旧对端不认识这条 ctl，直接丢掉。 */
export function noteIncomingRouteClose(
  live: LivePeer,
  msg: Record<string, unknown>,
  now: number
): void {
  const reason = typeof msg.reason === 'string' ? msg.reason : '';
  if (!ROUTE_CLOSE_REASONS.has(reason)) return;
  const raw = msg.retryAfterMs;
  const retryAfterMs =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : ROUTE_CLOSE_DEFAULT_MS;
  routeCloseByLive.set(live, { until: now + retryAfterMs });
}

/** 随后的 channel-closed 不计失败，并按对端给的 retryAfter 冷却再拨 DC。 */
export function applyRouteCloseCooldown(
  breaker: { noteRemoteRefusal(peer: string, until: number | null, now?: number): void },
  live: LivePeer | undefined,
  peer: string,
  reason: string
): boolean {
  const mark = live ? routeCloseByLive.get(live) : undefined;
  if (live && mark) routeCloseByLive.delete(live);
  if (mark) breaker.noteRemoteRefusal(peer, mark.until);
  return isIntentionalDcLoss(reason) || mark != null;
}

export function clearUnstableHealthyTimer(
  handles: Map<string, { clear(): void }>,
  peer: string
): void {
  handles.get(peer)?.clear();
  handles.delete(peer);
}

/** 同一条 DC 活过 healthy 窗口才清连击。掉线或换 attempt 的定时器作废。 */
export function armUnstableHealthyTimer(
  state: PeerManagerState,
  unstable: UnstableDcBackoff,
  handles: Map<string, { clear(): void }>,
  live: LivePeer
): void {
  clearUnstableHealthyTimer(handles, live.peerNodeId);
  const peer = live.peerNodeId;
  const attempt = live.dcAttemptId;
  const handle = state.scheduler.interval(() => {
    handle.clear();
    handles.delete(peer);
    const current = state.live.get(peer);
    if (current !== live || current.dcAttemptId !== attempt) return;
    unstable.noteHealthy(peer);
  }, RTC_DIAL_BREAKER_HEALTHY_MS);
  handles.set(peer, handle);
}

export type DcDropBreaker = {
  noteFailure(peer: string, kind: string, attemptId?: string, now?: number): void;
  noteUnstable?(peer: string, cooldownMs: number, now?: number): void;
  noteChannelLost?(peer: string, attemptId?: string): void;
};

export function settleEstablishedDcDrop(input: {
  breaker: DcDropBreaker;
  unstable: UnstableDcBackoff;
  peer: string;
  reason: string;
  attemptId: string | null;
  live: LivePeer | undefined;
  now: number;
}): void {
  input.breaker.noteChannelLost?.(input.peer, input.attemptId ?? undefined);
  if (countEstablishedDropAsDialFailure(input)) {
    input.breaker.noteFailure(
      input.peer,
      classifyRtcDialFailure(input.reason),
      input.attemptId ?? undefined,
      input.now
    );
    return;
  }
  const cooldown = input.unstable.noteShortLife(input.peer, dcLifetimeMs(input));
  if (cooldown > 0) input.breaker.noteUnstable?.(input.peer, cooldown, input.now);
}

/** 旧对端不会留中继，短命断开仍按拨号失败累计。认能力位的对端走不稳定冷却。 */
function countEstablishedDropAsDialFailure(input: {
  peer: string;
  reason: string;
}): boolean {
  if (!isPostEstablishDcLoss(input.reason)) return true;
  return !peerSupportsDcStableHold(input.peer);
}

function dcLifetimeMs(input: { live: LivePeer | undefined; now: number }): number {
  if (!input.live) return 0;
  return Math.max(0, input.now - input.live.linkSinceAt);
}

export function logDcDrop(live: LivePeer | undefined, reason: string, now: number): void {
  if (!live || live.transport !== 'dc') return;
  rtcLog('dc drop', {
    peer: live.peerNodeId,
    reason,
    attempt: live.dcAttemptId,
    proven: isLiveDcProven(live),
    lifetime_ms: Math.max(0, now - live.linkSinceAt),
  });
}
