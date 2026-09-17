// 一次性 tmux 命令失败的统一错误形态。runTmux 在抛出前已经走过 reportTmuxCommandFailure
// （落库 + 连接告警 + 设备 error 事件），下游的 onError 消费者据此跳过重复上报。
export class TmuxCommandFailedError extends Error {
  readonly name = 'TmuxCommandFailedError';
  /** 该错误已由抛出方上报过，不要再发第二次告警 / 设备错误事件。 */
  readonly reported = true;
}

export function isReportedTmuxError(error: unknown): boolean {
  return (
    error instanceof TmuxCommandFailedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { reported?: unknown }).reported === true)
  );
}
