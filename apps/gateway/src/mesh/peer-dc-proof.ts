import {
  DC_UNSTABLE_BACKOFF_MS,
  DC_UNSTABLE_STRIKES,
  DC_UNSTABLE_WINDOW_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  type PeerManagerState,
} from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { currentDcProofGeneration, dcLinkProven, subscribeDcLinkProof } from './rtc/dc-link-proof';
import { classifyRtcDialFailure } from './rtc/rtc-dial-breaker';
import { rtcLog } from './rtc/rtc-log';

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
 * replaced 掉的 relay/ws 要等新 DC 证明自己（或等到 PEER_RETIRE_MAX_MS）才真正关掉。
 * 在途流仍走原来的排空判断，这里只挡 streams===0 的提前收尾。
 */
export function shouldHoldUnprovenDc(
  state: PeerManagerState,
  retiring: LivePeer,
  elapsed: number
): boolean {
  if (elapsed >= PEER_RETIRE_MAX_MS) return false;
  if (retiring.retireReason !== 'replaced' || retiring.transport === 'dc') return false;
  const next = state.live.get(retiring.peerNodeId);
  if (!next || next.transport !== 'dc') return false;
  return !isLiveDcProven(next);
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

export class UnstableDcBackoff {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly strikes = DC_UNSTABLE_STRIKES,
    private readonly windowMs = DC_UNSTABLE_WINDOW_MS,
    private readonly backoffMs = DC_UNSTABLE_BACKOFF_MS
  ) {}

  /** 未证明就夭折记一笔。凑满次数返回冷却毫秒，证明过一次则清零。 */
  note(peer: string, proven: boolean): number {
    if (proven) {
      this.hits.delete(peer);
      return 0;
    }
    const now = this.now();
    const recent = (this.hits.get(peer) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.hits.set(peer, recent);
    return recent.length >= this.strikes ? this.backoffMs : 0;
  }
}

export type DcDropBreaker = {
  noteFailure(peer: string, kind: string, attemptId?: string, now?: number): void;
  noteUnstable?(peer: string, cooldownMs: number, now?: number): void;
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
  if (!isPostEstablishDcLoss(input.reason)) {
    input.breaker.noteFailure(
      input.peer,
      classifyRtcDialFailure(input.reason),
      input.attemptId ?? undefined,
      input.now
    );
    return;
  }
  const proven = input.live !== undefined && isLiveDcProven(input.live);
  const cooldown = input.unstable.note(input.peer, proven);
  if (cooldown > 0) input.breaker.noteUnstable?.(input.peer, cooldown, input.now);
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
