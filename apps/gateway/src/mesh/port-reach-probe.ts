import net from 'node:net';

export const PORT_PROBE_DEADLINE_MS = 3_000;

export type TcpProbeVerdict = 'ok' | 'refused' | 'timeout';

export type TcpProbeSocket = {
  once(event: 'connect', listener: () => void): void;
  once(event: 'error', listener: (err: NodeJS.ErrnoException) => void): void;
  destroy(): void;
};

export type TcpConnectFn = (opts: { host: string; port: number }) => TcpProbeSocket;

function stripHostBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

const defaultConnect: TcpConnectFn = (opts) => net.connect(opts);

/** TCP connect：3 s 截止；成功立刻断开。不可达类错误记为 timeout。 */
export function probeTcpConnect(
  host: string,
  port: number,
  deadlineMs = PORT_PROBE_DEADLINE_MS,
  connect: TcpConnectFn = defaultConnect
): Promise<TcpProbeVerdict> {
  const target = stripHostBrackets(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict: TcpProbeVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const socket = connect({ host: target, port });
    const timer = setTimeout(() => finish('timeout'), deadlineMs);
    socket.once('connect', () => finish('ok'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ECONNREFUSED' ? 'refused' : 'timeout');
    });
  });
}
