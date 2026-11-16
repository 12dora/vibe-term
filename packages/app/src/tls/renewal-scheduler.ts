import { errorMessage } from '../lib/error-message';
import {
  RENEWAL_BACKOFF_MAX_MS,
  RENEWAL_BACKOFF_MIN_MS,
  RENEWAL_CHECK_INTERVAL_MS,
} from './acme-constants';

export type RenewalSchedulerOptions = {
  isDue: () => boolean | Promise<boolean>;
  renew: () => Promise<void>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  checkIntervalMs?: number;
  log?: (message: string) => void;
};

export class RenewalScheduler {
  private timer: unknown = null;
  private stopped = true;
  private backoffMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (id: unknown) => void;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: RenewalSchedulerOptions) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.checkIntervalMs = opts.checkIntervalMs ?? RENEWAL_CHECK_INTERVAL_MS;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  get nextBackoffMs(): number {
    return this.backoffMs;
  }

  start(): void {
    this.stopped = false;
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
    this.arm(this.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  resetBackoff(): void {
    this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
  }

  retryAfterFailure(detail?: string): void {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RENEWAL_BACKOFF_MAX_MS);
    this.opts.log?.(
      detail
        ? `tls renewal failed, retry in ${wait}ms: ${detail}`
        : `tls renewal failed, retry in ${wait}ms`
    );
    this.arm(wait);
  }

  async runNow(): Promise<void> {
    await this.tick(true);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      void this.tick(false);
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private async tick(force: boolean): Promise<void> {
    if (this.stopped && !force) return;
    try {
      if (force || (await this.opts.isDue())) {
        await this.opts.renew();
      }
      this.backoffMs = RENEWAL_BACKOFF_MIN_MS;
      this.arm(this.checkIntervalMs);
    } catch (error) {
      this.retryAfterFailure(errorMessage(error));
    }
  }
}
