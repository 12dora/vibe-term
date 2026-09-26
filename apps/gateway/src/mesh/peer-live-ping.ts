import { RTT_EVENT_MIN_INTERVAL_MS, rttChangedMaterially } from './address-class';
import { missedPongExceeded } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';

export type PeerPingStep = 'skip' | 'ping' | 'drop-live' | 'drop-retire';

/**
 * live 继续心跳。退役中的 DC 也要心跳：路径死了就关掉，不要挂到 30 分钟泄漏上限。
 * 候选由 hold 自己的测量超时关掉。
 */
export function peerPingStep(
  live: LivePeer,
  current: LivePeer | undefined,
  retiring: ReadonlySet<LivePeer> | undefined,
  rttMs: number
): PeerPingStep {
  const ownsLive = current === live;
  const ownsRetire = live.transport === 'dc' && live.retiring && retiring?.has(live) === true;
  if (!ownsLive && !ownsRetire) return 'skip';
  if (notePeerPingTick(live, rttMs) !== 'drop') return 'ping';
  return ownsLive ? 'drop-live' : 'drop-retire';
}

/** 一次 ping 周期：有新 inbound 则清零 missed；否则累加，达自适应窗口则判死。 */
export function notePeerPingTick(live: LivePeer, rttMs: number): 'drop' | 'ping' {
  const lastFrameAt = live.session.lastFrameAt;
  if (lastFrameAt != null && lastFrameAt > live.lastInboundFrameAt) {
    live.lastInboundFrameAt = lastFrameAt;
    live.missedPongs = 0;
  } else live.missedPongs += 1;
  if (missedPongExceeded(live.missedPongs, rttMs)) return 'drop';
  return 'ping';
}

export function armPeerPing(input: {
  live: LivePeer;
  intervalMs: number;
  schedule: (fn: () => void, ms: number) => { clear(): void };
  current: () => LivePeer | undefined;
  retiring: () => ReadonlySet<LivePeer> | undefined;
  rttMs: () => number;
  sendCtl: (msg: { t: 'ping'; sentAt: number }) => void;
  onDropLive: () => void;
  onDropRetire: () => void;
}): void {
  const { live } = input;
  live.pingTimer?.clear();
  live.missedPongs = 0;
  live.lastInboundFrameAt = live.session.lastFrameAt ?? live.lastInboundFrameAt;
  const sendPing = () => {
    live.pingSentAt = performance.now();
    input.sendCtl({ t: 'ping', sentAt: live.pingSentAt ?? performance.now() });
  };
  live.pingTimer = input.schedule(() => {
    const action = peerPingStep(live, input.current(), input.retiring(), input.rttMs());
    if (action === 'drop-live') input.onDropLive();
    else if (action === 'drop-retire') input.onDropRetire();
    else if (action === 'ping') sendPing();
  }, input.intervalMs);
}

export function clearOutstandingPing(live: LivePeer): void {
  live.pingSentAt = null;
}

export function shouldEmitPeerRtt(live: LivePeer, now: number): boolean {
  if (!rttChangedMaterially(live.lastEmittedRttMs, live.rttMs)) return false;
  if (live.lastEmittedRttMs != null && now - live.lastRttEmitAt < RTT_EVENT_MIN_INTERVAL_MS) {
    return false;
  }
  return true;
}
