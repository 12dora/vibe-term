import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';

/**
 * 测试用回声服务，全部走 node:net：Bun 的 socket 在 resume 之后 `pause()` 近乎失效，
 * 而 node:net 的 pause 是真背压；半开也只有逐 socket 打 `allowHalfOpen` 才生效。
 */
export type EchoServer = {
  readonly port: number;
  readonly connections: number;
  stop: () => void;
};

type Listening = { server: Server; port: number };

function listenOn(onConnection: (socket: Socket) => void): Listening {
  const server = createServer({ allowHalfOpen: true, noDelay: true });
  server.on('error', () => {});
  server.on('connection', (socket) => {
    socket.allowHalfOpen = true;
    socket.on('error', () => {});
    onConnection(socket);
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('failed to bind test server');
  return { server, port: address.port };
}

function stopper(server: Server, sockets: Set<Socket>): () => void {
  return () => {
    try {
      server.close();
    } catch {
      // 已经关闭
    }
    for (const socket of [...sockets]) socket.destroy();
    sockets.clear();
  };
}

/** 带背压的回声：写不进去就停读，对端的 FIN 原样回敬。 */
export function startEchoServer(): EchoServer {
  const state = { connections: 0 };
  const sockets = new Set<Socket>();
  const { server, port } = listenOn((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (!socket.write(chunk)) socket.pause();
    });
    socket.on('drain', () => socket.resume());
    socket.on('end', () => socket.end());
  });
  return {
    port,
    get connections() {
      return state.connections;
    },
    stop: stopper(server, sockets),
  };
}

/** 连上就写一段数据再发 FIN：用于验证本地 FIN 映射成流的 END。 */
export function startFinServer(payload: Uint8Array): EchoServer {
  const state = { connections: 0 };
  const sockets = new Set<Socket>();
  const { server, port } = listenOn((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => {});
    socket.write(payload);
    socket.end();
  });
  return {
    port,
    get connections() {
      return state.connections;
    },
    stop: stopper(server, sockets),
  };
}

/** 收到 FIN 之后才产生响应：用于验证写半边关闭没把读半边一起带走。 */
export function startAfterFinServer(payload: Uint8Array): EchoServer & { received: () => number } {
  const state = { connections: 0, received: 0 };
  const sockets = new Set<Socket>();
  const { server, port } = listenOn((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      state.received += chunk.byteLength;
    });
    socket.on('end', () => {
      socket.write(payload);
      socket.end();
    });
  });
  return {
    port,
    get connections() {
      return state.connections;
    },
    received: () => state.received,
    stop: stopper(server, sockets),
  };
}

/** 一开始完全不读的回声服务：用来把流的窗口撑满，验证背压而不是缓冲。 */
export function startSlowEchoServer(): EchoServer & { release: () => void } {
  const state = { connections: 0 };
  const sockets = new Set<Socket>();
  const held: Socket[] = [];
  let released = false;
  const { server, port } = listenOn((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (!socket.write(chunk)) socket.pause();
    });
    socket.on('drain', () => {
      if (released) socket.resume();
    });
    socket.on('end', () => socket.end());
    if (released) return;
    socket.pause();
    held.push(socket);
  });
  return {
    port,
    get connections() {
      return state.connections;
    },
    release() {
      released = true;
      for (const socket of held.splice(0)) socket.resume();
    },
    stop: stopper(server, sockets),
  };
}
