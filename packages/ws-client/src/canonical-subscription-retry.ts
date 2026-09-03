const DEFAULT_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 4;

export class CanonicalSubscriptionRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(
    private readonly retryMs = DEFAULT_RETRY_MS,
    private readonly maxRetryMs = DEFAULT_MAX_RETRY_MS,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS
  ) {}

  request(retry: () => void): boolean {
    if (this.timer) return true;
    if (this.attempt >= this.maxAttempts) return false;
    const delay = Math.min(this.retryMs * 2 ** this.attempt, this.maxRetryMs);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      retry();
    }, delay);
    return true;
  }

  hasAttempted(): boolean {
    return this.attempt > 0;
  }

  resolved(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
  }
}
