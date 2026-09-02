import { envInt } from '../mesh-log';
import { rtcLog } from './rtc-log';

export const RTC_DIAL_BREAKER_FAILS = 8;
export const RTC_DIAL_BREAKER_MS_DEFAULT = 6 * 60 * 60 * 1000;

export type RtcDialBreakerOpenEvent = {
  peer: string;
  fails: number;
  until: number;
};

type PeerState = {
  fails: number;
  until: number;
};

export type RtcDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  onOpen?: (event: RtcDialBreakerOpenEvent) => void;
};

export class RtcDialBreaker {
  private readonly now: () => number;
  private readonly breakerMs: number;
  private readonly failLimit: number;
  private readonly onOpen?: (event: RtcDialBreakerOpenEvent) => void;
  private readonly peers = new Map<string, PeerState>();

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.breakerMs =
      opts.breakerMs ?? envInt('TMEX_RTC_DIAL_BREAKER_MS', RTC_DIAL_BREAKER_MS_DEFAULT, 1);
    this.failLimit = opts.failLimit ?? RTC_DIAL_BREAKER_FAILS;
    this.onOpen = opts.onOpen;
  }

  shouldSkip(peer: string, now = this.now()): boolean {
    const state = this.peers.get(peer);
    if (!state) return false;
    if (state.until <= 0) return false;
    if (now >= state.until) {
      this.peers.delete(peer);
      return false;
    }
    return true;
  }

  noteFailure(peer: string, now = this.now()): { opened: boolean; open: boolean; until?: number } {
    if (this.shouldSkip(peer, now)) {
      const until = this.peers.get(peer)?.until ?? now + this.breakerMs;
      return { opened: false, open: true, until };
    }
    const prev = this.peers.get(peer);
    const fails = (prev?.fails ?? 0) + 1;
    if (fails < this.failLimit) {
      this.peers.set(peer, { fails, until: 0 });
      return { opened: false, open: false };
    }
    const until = now + this.breakerMs;
    this.peers.set(peer, { fails, until });
    this.onOpen?.({ peer, fails, until });
    return { opened: true, open: true, until };
  }

  noteSuccess(peer: string): void {
    this.peers.delete(peer);
  }

  notePeerChanged(peer: string): void {
    this.peers.delete(peer);
  }

  reset(peer?: string): void {
    if (peer) this.peers.delete(peer);
    else this.peers.clear();
  }
}

export function createGatewayRtcDialBreaker(): RtcDialBreaker {
  return new RtcDialBreaker({
    onOpen: ({ peer, fails, until }) => {
      rtcLog('breaker open', { peer, fails, until: new Date(until).toISOString() });
    },
  });
}
