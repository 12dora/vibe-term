import dgram from 'node:dgram';

export function listenUdp(socket: dgram.Socket, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    socket.once('error', onError);
    socket.bind(port, host, () => {
      socket.off('error', onError);
      resolve();
    });
  });
}

export function udpErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isAddrNotAvail(err: unknown): boolean {
  return udpErrorCode(err) === 'EADDRNOTAVAIL';
}

export type BindUdpFn = (host: string, port: number) => Promise<dgram.Socket>;

export async function bindUdp(host: string, port: number): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4');
  try {
    await listenUdp(socket, port, host);
    return socket;
  } catch (err) {
    await closeSocket(socket);
    throw err;
  }
}

export type BindUdpResult = { ok: true; socket: dgram.Socket } | { ok: false; code: string | null };

export async function bindUdpResult(host: string, port: number): Promise<BindUdpResult> {
  try {
    return { ok: true, socket: await bindUdp(host, port) };
  } catch (err) {
    return { ok: false, code: udpErrorCode(err) };
  }
}

/** 指定地址不在本机时退回 0.0.0.0，避免接口消失导致 TURN 起不来。 */
export async function listenUdpOrWildcard(
  port: number,
  host: string,
  log: (line: string) => void,
  bind: BindUdpFn = bindUdp
): Promise<{ socket: dgram.Socket; host: string }> {
  try {
    return { socket: await bind(host, port), host };
  } catch (err) {
    if (!isAddrNotAvail(err) || host === '0.0.0.0') throw err;
    log(`turn: bind ${host} failed (EADDRNOTAVAIL), falling back to 0.0.0.0`);
    return { socket: await bind('0.0.0.0', port), host: '0.0.0.0' };
  }
}

export function closeSocket(socket: dgram.Socket | null | undefined): Promise<void> {
  if (!socket) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      socket.once('close', () => resolve());
      socket.close();
    } catch {
      resolve();
    }
  });
}

export async function tryBindUdp(host: string, port: number): Promise<dgram.Socket | null> {
  try {
    return await bindUdp(host, port);
  } catch {
    return null;
  }
}
