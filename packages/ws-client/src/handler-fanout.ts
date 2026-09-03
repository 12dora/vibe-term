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
