import { RTT_EVENT_MIN_INTERVAL_MS, rttChangedMaterially } from './address-class';
import { missedPongExceeded } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';

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

export function shouldEmitPeerRtt(live: LivePeer, now: number): boolean {
  if (!rttChangedMaterially(live.lastEmittedRttMs, live.rttMs)) return false;
  if (live.lastEmittedRttMs != null && now - live.lastRttEmitAt < RTT_EVENT_MIN_INTERVAL_MS) {
    return false;
  }
  return true;
}
