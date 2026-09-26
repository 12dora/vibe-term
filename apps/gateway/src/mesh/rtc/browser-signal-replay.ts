import type { RtcSignalMessage } from '../mesh-deps';

/** `/mesh/ws` 断开期间先攒着，重连后补发 node→browser 的 answer / candidate。 */
export const RTC_BROWSER_REPLAY_TTL_MS = 15_000;
export const RTC_BROWSER_REPLAY_MAX_SIDS = 32;
export const RTC_BROWSER_REPLAY_MAX_MESSAGES = 16;

type Bucket = { at: number; signals: RtcSignalMessage[] };

export class BrowserSignalReplay {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly ttlMs = RTC_BROWSER_REPLAY_TTL_MS) {}

  remember(sid: string, signal: RtcSignalMessage, now: number): void {
    this.sweep(now);
    let bucket = this.buckets.get(sid);
    if (!bucket) {
      if (this.buckets.size >= RTC_BROWSER_REPLAY_MAX_SIDS) return;
      bucket = { at: now, signals: [] };
      this.buckets.set(sid, bucket);
    }
    bucket.at = now;
    if (bucket.signals.length >= RTC_BROWSER_REPLAY_MAX_MESSAGES) bucket.signals.shift();
    bucket.signals.push(signal);
  }

  peek(sid: string, now: number): RtcSignalMessage[] {
    this.sweep(now);
    const bucket = this.buckets.get(sid);
    return bucket ? [...bucket.signals] : [];
  }

  private sweep(now: number): void {
    for (const [sid, bucket] of this.buckets) {
      if (now - bucket.at < this.ttlMs) continue;
      this.buckets.delete(sid);
    }
  }
}
