import { type Socket, connect } from 'node:net';
import { destroySocket } from './socket-handlers';

export type TcpDial = {
  /** 连上返回 socket；超时或被取消则 reject。 */
  readonly result: Promise<Socket>;
  cancel(): void;
};

export type TcpDialTarget = { host: string; port: number };

/**
 * 可取消的 TCP 拨号。超时/取消时把底层 socket 一并关掉——否则对着一个只丢 SYN 的地址反复开流
 * 就能耗光 fd。已经连上之后再 cancel 也会关掉，供流被 RST 时收拾残局。
 */
export function dialTcp(target: TcpDialTarget, timeoutMs: number): TcpDial {
  const socket = connect({ host: target.host, port: target.port, allowHalfOpen: true });
  socket.allowHalfOpen = true;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onConnected: ((value: Socket) => void) | null = null;
  let onFailed: ((err: Error) => void) | null = null;
  const result = new Promise<Socket>((resolve, reject) => {
    onConnected = resolve;
    onFailed = reject;
  });
  const stopTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (reason: string): void => {
    if (settled) return;
    settled = true;
    stopTimer();
    destroySocket(socket);
    onFailed?.(new Error(reason));
  };
  socket.once('connect', () => {
    if (settled) return;
    settled = true;
    stopTimer();
    onConnected?.(socket);
  });
  socket.once('error', (err: Error) => fail(err.message || 'portmap-dial-failed'));
  socket.once('close', () => fail('portmap-dial-closed'));
  timer = setTimeout(() => fail('portmap-dial-timeout'), timeoutMs);
  return {
    result,
    cancel: () => {
      fail('portmap-dial-cancelled');
      destroySocket(socket);
    },
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
