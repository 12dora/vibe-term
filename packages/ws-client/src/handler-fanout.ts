// 订阅回调扇出：单个 handler 抛错不得打断其余订阅者，统一在此吞掉并打点。

export function notifyHandlers<T>(
  handlers: Iterable<(value: T) => void>,
  value: T,
  label: string
): void {
  for (const handler of handlers) {
    try {
      handler(value);
    } catch (err) {
      console.error(`[borsh-client] ${label} handler error:`, err);
    }
  }
}

/** 一组订阅回调：`add` 返回注销函数，`emit` 逐个调用并吞掉单个回调的异常。 */
export class HandlerSet<T = void> {
  private readonly handlers = new Set<(value: T) => void>();

  constructor(private readonly label: string) {}

  add(handler: (value: T) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(value: T): void {
    notifyHandlers(this.handlers, value, this.label);
  }
}
