import { type Socket, connect } from 'node:net';
import { destroySocket } from './socket-handlers';
import { type TargetPolicyOptions, resolveAllowedTargets } from './target-policy';

export type TcpDial = {
  /** 连上返回 socket；超时、被取消或目标被策略禁止（PortMapError `target_forbidden`）则 reject。 */
  readonly result: Promise<Socket>;
  cancel(): void;
};

export type TcpDialTarget = { host: string; port: number };

/**
 * 可取消的 TCP 拨号。先按目标策略解析并检查全部地址，再直连检查过的 IP（不二次解析）；
 * 连接被拒时依次尝试下一个地址。时限覆盖解析 + 连接。超时/取消时把底层 socket 一并关掉——
 * 否则对着一个只丢 SYN 的地址反复开流就能耗光 fd。已经连上之后再 cancel 也会关掉，供流被 RST 时收拾残局。
 */
export function dialTcp(
  target: TcpDialTarget,
  timeoutMs: number,
  policy?: TargetPolicyOptions
): TcpDial {
  let socket: Socket | null = null;
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
  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    stopTimer();
    if (socket) destroySocket(socket);
    onFailed?.(err);
  };
  const attempt = (addresses: string[], index: number): void => {
    const address = addresses[index];
    if (address === undefined) {
      fail(new Error('portmap-dial-failed'));
      return;
    }
    const current = connect({ host: address, port: target.port, allowHalfOpen: true });
    current.allowHalfOpen = true;
    socket = current;
    current.once('connect', () => {
      if (settled || socket !== current) return;
      settled = true;
      stopTimer();
      onConnected?.(current);
    });
    current.once('error', (err: Error) => {
      if (settled || socket !== current) return;
      if (index + 1 < addresses.length) {
        socket = null;
        destroySocket(current);
        attempt(addresses, index + 1);
        return;
      }
      fail(new Error(err.message || 'portmap-dial-failed'));
    });
    current.once('close', () => {
      if (socket === current) fail(new Error('portmap-dial-closed'));
    });
  };
  timer = setTimeout(() => fail(new Error('portmap-dial-timeout')), timeoutMs);
  resolveAllowedTargets(target.host, target.port, policy).then(
    (addresses) => {
      if (settled) return;
      try {
        attempt(addresses, 0);
      } catch (err) {
        fail(err instanceof Error ? err : new Error('portmap-dial-failed'));
      }
    },
    (err: unknown) => fail(err instanceof Error ? err : new Error('portmap-dial-failed'))
  );
  return {
    result,
    cancel: () => {
      fail(new Error('portmap-dial-cancelled'));
      if (socket) destroySocket(socket);
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
