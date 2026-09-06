export type TcpDial<T> = {
  /** 连上返回 socket；超时或被取消则 reject。 */
  readonly result: Promise<Bun.Socket<T>>;
  cancel(): void;
};

function closeQuietly(socket: { terminate(): void }): void {
  try {
    socket.terminate();
  } catch {
    // 已经关闭
  }
}

/**
 * 可取消的 TCP 拨号。`Promise.race` 只能让调用方不再等，底层的连接尝试还在跑，所以超时/取消时
 * 一并接管迟到的 socket 并关掉——否则对着一个只丢 SYN 的地址反复开流就能耗光 fd。
 */
export function dialTcp<T>(options: Bun.TCPSocketConnectOptions<T>, timeoutMs: number): TcpDial<T> {
  let cancelled = false;
  let abort: ((err: Error) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const connect = Bun.connect<T>(options);
  const cancel = (reason: string): void => {
    if (cancelled) return;
    cancelled = true;
    stopTimer();
    void connect.then(closeQuietly).catch(() => {});
    abort?.(new Error(reason));
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = reject;
  });
  const connected = connect.then(
    (socket) => {
      stopTimer();
      if (cancelled) {
        closeQuietly(socket);
        throw new Error('portmap-dial-cancelled');
      }
      return socket;
    },
    (err: unknown) => {
      stopTimer();
      throw err;
    }
  );
  timer = setTimeout(() => cancel('portmap-dial-timeout'), timeoutMs);
  return {
    result: Promise.race([connected, aborted]),
    cancel: () => cancel('portmap-dial-cancelled'),
  };
}

/**
 * 给 peer 链路的拨号加时限。链路层没有取消入口，超时后只能把迟到的结果交给 `onAbandon` 收拾。
 */
export function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onAbandon: (value: T) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('portmap-dial-timeout'));
    }, timeoutMs);
  });
  const guarded = work.then((value) => {
    if (!timedOut) return value;
    onAbandon(value);
    throw new Error('portmap-dial-timeout');
  });
  return Promise.race([guarded, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
