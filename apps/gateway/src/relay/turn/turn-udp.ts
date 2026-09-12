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
