import net from 'node:net';

export const PORT_PROBE_DEADLINE_MS = 3_000;

export type TcpProbeVerdict = 'ok' | 'refused' | 'timeout';
export type TcpProbeResult = {
  verdict: TcpProbeVerdict;
  connectMs: number | null;
  /** 握手成功时对端地址（fake-IP / 本地代理终结判定用）；探不到时 null */
  remoteAddress?: string | null;
};

export type TcpProbeSocket = {
  remoteAddress?: string;
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
): Promise<TcpProbeResult> {
  const target = stripHostBrackets(host);
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = performance.now();
    const finish = (verdict: TcpProbeVerdict) => {
      if (settled) return;
      settled = true;
      const connectMs = verdict === 'ok' ? performance.now() - startedAt : null;
      const remoteAddress = verdict === 'ok' ? (socket.remoteAddress ?? null) : null;
      clearTimeout(timer);
      socket.destroy();
      resolve({ verdict, connectMs, remoteAddress });
    };
    const socket = connect({ host: target, port });
    const timer = setTimeout(() => finish('timeout'), deadlineMs);
    socket.once('connect', () => finish('ok'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ECONNREFUSED' ? 'refused' : 'timeout');
    });
  });
}
