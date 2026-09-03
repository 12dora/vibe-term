const DEFAULT_RETRY_MS = 250;
const DEFAULT_MAX_RETRY_MS = 5_000;

export class CanonicalSubscriptionRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(
    private readonly retryMs = DEFAULT_RETRY_MS,
    private readonly maxRetryMs = DEFAULT_MAX_RETRY_MS
  ) {}

  request(retry: () => void): void {
    if (this.timer) return;
    const delay = Math.min(this.retryMs * 2 ** this.attempt, this.maxRetryMs);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      retry();
    }, delay);
  }

  resolved(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
  }
}
