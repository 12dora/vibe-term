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
  private readonly scheduled = new Map<
    string,
    { request: PendingContentRequest; timer: ReturnType<typeof setTimeout> }
  >();

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
    this.scheduled.set(key, {
      request,
      timer: setTimeout(() => {
        this.scheduled.delete(key);
        this.options.retry(request);
      }, RETRY_DELAY_MS),
    });
  }

  cancelScheduled(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void {
    const key = retryKey({ kind, deviceId, paneId });
    const scheduled = this.scheduled.get(key);
    if (scheduled) clearTimeout(scheduled.timer);
    this.scheduled.delete(key);
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

  takeScheduled(): PendingContentRequest[] {
    const requests = Array.from(this.scheduled.values(), ({ request }) => request);
    for (const { timer } of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    this.attempts.clear();
    return requests;
  }

  dispose(): void {
    this.takeScheduled();
  }
}
