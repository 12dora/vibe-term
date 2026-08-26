export interface StreamAccumulatorSink {
  emitText(messageId: string, delta: string): void;
  emitReasoning(messageId: string, delta: string): void;
}

export interface StreamAccumulatorOptions {
  flushIntervalMs: number;
  flushMaxBytes: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class StreamAccumulator {
  private textBuffer = '';
  private reasoningBuffer = '';
  private pendingTextDelta = '';
  private pendingTextMessageId = '';
  private pendingReasoningDelta = '';
  private pendingReasoningMessageId = '';
  private flushTimer: unknown = null;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(
    private readonly sink: StreamAccumulatorSink,
    private readonly options: StreamAccumulatorOptions
  ) {
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get inProgressText(): string {
    return this.textBuffer;
  }

  get inProgressReasoning(): string {
    return this.reasoningBuffer;
  }

  queueTextDelta(messageId: string, delta: string): void {
    this.textBuffer += delta;
    if (this.pendingTextDelta && this.pendingTextMessageId !== messageId) {
      this.flush();
    }
    this.pendingTextMessageId = messageId;
    this.pendingTextDelta += delta;
    this.scheduleFlush();
  }

  queueReasoningDelta(messageId: string, delta: string): void {
    this.reasoningBuffer += delta;
    if (this.pendingReasoningDelta && this.pendingReasoningMessageId !== messageId) {
      this.flush();
    }
    this.pendingReasoningMessageId = messageId;
    this.pendingReasoningDelta += delta;
    this.scheduleFlush();
  }

  flush(): void {
    this.clearTimer();
    if (this.pendingTextDelta) {
      this.sink.emitText(this.pendingTextMessageId, this.pendingTextDelta);
      this.pendingTextDelta = '';
    }
    if (this.pendingReasoningDelta) {
      this.sink.emitReasoning(this.pendingReasoningMessageId, this.pendingReasoningDelta);
      this.pendingReasoningDelta = '';
    }
  }

  clearTimer(): void {
    if (this.flushTimer) {
      this.cancel(this.flushTimer);
      this.flushTimer = null;
    }
  }

  clearInProgress(): void {
    this.textBuffer = '';
    this.reasoningBuffer = '';
  }

  consumeInProgressText(): string {
    const text = this.textBuffer;
    this.textBuffer = '';
    this.reasoningBuffer = '';
    return text;
  }

  reset(): void {
    this.clearTimer();
    this.textBuffer = '';
    this.reasoningBuffer = '';
    this.pendingTextDelta = '';
    this.pendingTextMessageId = '';
    this.pendingReasoningDelta = '';
    this.pendingReasoningMessageId = '';
  }

  private scheduleFlush(): void {
    if (
      this.pendingTextDelta.length + this.pendingReasoningDelta.length >=
      this.options.flushMaxBytes
    ) {
      this.flush();
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      this.flush();
    }, this.options.flushIntervalMs);
  }
}
