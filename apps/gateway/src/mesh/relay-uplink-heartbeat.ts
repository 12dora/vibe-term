import type { LinkSession } from '@tmex/shared/link';
import type { MeshScheduler } from './types';

export type RelayUplinkHeartbeatOptions = {
  scheduler: MeshScheduler;
  intervalMs: number;
  missedLimit: number;
  sendPing: (link: LinkSession) => void;
  onTimeout: (reason: 'missed-pong' | 'ping-failed') => void;
  onTick?: () => void;
};

/** ping→pong 测 RTT（取最新一次）；重连时 `start`/`reset` 会清零。 */
export class RelayUplinkHeartbeat {
  rttMs: number | null = null;
  private handle: { clear: () => void } | null = null;
  private missed = 0;
  private pingAt: number | null = null;

  constructor(private readonly opts: RelayUplinkHeartbeatOptions) {}

  start(link: LinkSession, isCurrent: () => boolean): void {
    this.stop();
    this.rttMs = null;
    this.pingAt = null;
    this.missed = 0;
    this.handle = this.opts.scheduler.interval(() => {
      if (!isCurrent()) return;
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

  onPong(): void {
    this.missed = 0;
    if (this.pingAt === null) return;
    this.rttMs = Math.max(0, this.opts.scheduler.now() - this.pingAt);
    this.pingAt = null;
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
