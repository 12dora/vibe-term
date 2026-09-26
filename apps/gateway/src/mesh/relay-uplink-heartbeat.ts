import type { LinkSession } from '@vibeterm/shared/link';
import type { MeshScheduler } from './types';

export type RelayUplinkHeartbeatOptions = {
  scheduler: MeshScheduler;
  intervalMs: number;
  missedLimit: number;
  sendPing: (link: LinkSession) => void;
  onTimeout: (reason: 'missed-pong' | 'ping-failed') => void;
  onTick?: () => void;
  onRtt?: (rttMs: number) => void;
};

/** ping→pong 测 RTT（取最新一次）；重连时 `start`/`reset` 会清零。 */
export class RelayUplinkHeartbeat {
  rttMs: number | null = null;
  private handle: { clear: () => void } | null = null;
  private missed = 0;
  private pingAt: number | null = null;
  private seenFrameAt: number | null = null;

  constructor(private readonly opts: RelayUplinkHeartbeatOptions) {}

  start(link: LinkSession, isCurrent: () => boolean): void {
    this.stop();
    this.rttMs = null;
    this.pingAt = null;
    this.missed = 0;
    this.seenFrameAt = null;
    this.handle = this.opts.scheduler.interval(() => {
      if (!isCurrent()) return;
      this.noteInbound(link);
      if (this.missed >= this.opts.missedLimit) {
        this.opts.onTimeout('missed-pong');
        return;
      }
      this.missed += 1;
      this.pingAt = this.opts.scheduler.now();
      try {
        this.opts.sendPing(link);
      } catch {
        this.opts.onTimeout('ping-failed');
        return;
      }
      this.opts.onTick?.();
    }, this.opts.intervalMs);
  }

  /** 任意入站帧都算活着；RTT 仍只从真正的 pong 取。 */
  private noteInbound(link: LinkSession): void {
    const seen = link.lastFrameAt;
    if (typeof seen !== 'number') return;
    if (this.seenFrameAt !== null && seen !== this.seenFrameAt) this.missed = 0;
    this.seenFrameAt = seen;
  }

  onPong(): void {
    this.missed = 0;
    if (this.pingAt === null) return;
    this.rttMs = Math.max(0, this.opts.scheduler.now() - this.pingAt);
    this.pingAt = null;
    this.opts.onRtt?.(this.rttMs);
  }

  reset(): void {
    this.stop();
    this.rttMs = null;
    this.pingAt = null;
  }

  stop(): void {
    this.handle?.clear();
    this.handle = null;
    this.missed = 0;
  }
}
