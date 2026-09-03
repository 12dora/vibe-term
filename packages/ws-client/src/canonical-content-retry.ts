import type { PendingContentRequest } from './canonical-content-transactions';

const RETRY_DELAY_MS = 50;
const MAX_ATTEMPTS = 3;

function retryKey(request: Pick<PendingContentRequest, 'deviceId' | 'kind' | 'paneId'>): string {
  return `${request.deviceId}\0${request.paneId}\0${request.kind}`;
}

export interface CanonicalContentRetryOptions {
  retry(request: PendingContentRequest): void;
  exhausted(request: PendingContentRequest): void;
}

export class CanonicalContentRetry {
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: CanonicalContentRetryOptions) {}

  schedule(request: PendingContentRequest): void {
    const key = retryKey(request);
    this.cancelScheduled(request.kind, request.deviceId, request.paneId);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    if (attempt >= MAX_ATTEMPTS) {
      this.options.exhausted(request);
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.options.retry(request);
      }, RETRY_DELAY_MS)
    );
  }

  cancelScheduled(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void {
    const key = retryKey({ kind, deviceId, paneId });
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  complete(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void {
    const key = retryKey({ kind, deviceId, paneId });
    this.cancelScheduled(kind, deviceId, paneId);
    this.attempts.delete(key);
  }

  clearPane(deviceId: string, paneId: string): void {
    this.complete('screen', deviceId, paneId);
    this.complete('history', deviceId, paneId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempts.clear();
  }
}
