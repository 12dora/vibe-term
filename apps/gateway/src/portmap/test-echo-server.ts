/** 测试用回声服务：带背压的 echo，并把 FIN 原样回敬，用于验证半关闭。 */
type EchoData = { queue: Uint8Array[]; fin: boolean };

function flush(socket: Bun.Socket<EchoData>): void {
  const queue = socket.data.queue;
  while (queue.length > 0) {
    const head = queue[0] as Uint8Array;
    const written = socket.write(head);
    if (written < 0) {
      queue.length = 0;
      return;
    }
    if (written < head.byteLength) {
      queue[0] = head.subarray(written);
      return;
    }
    queue.shift();
  }
  if (socket.data.fin) socket.end();
}

export type EchoServer = {
  readonly port: number;
  readonly connections: number;
  stop: () => void;
};

export function startEchoServer(): EchoServer {
  const state = { connections: 0 };
  const server = Bun.listen<EchoData>({
    hostname: '127.0.0.1',
    port: 0,
    allowHalfOpen: true,
    socket: {
      binaryType: 'uint8array',
      open(socket) {
        socket.data = { queue: [], fin: false };
        state.connections += 1;
      },
      data(socket, chunk) {
        socket.data.queue.push(new Uint8Array(chunk as unknown as Uint8Array));
        flush(socket);
      },
      drain(socket) {
        flush(socket);
      },
      end(socket) {
        socket.data.fin = true;
        flush(socket);
      },
    },
  });
  return {
    port: server.port,
    get connections() {
      return state.connections;
    },
    stop: () => server.stop(true),
  };
}

/** 连上就写一段数据再发 FIN：用于验证本地 FIN 映射成流的 END。 */
export function startFinServer(payload: Uint8Array): EchoServer {
  const state = { connections: 0 };
  const server = Bun.listen<EchoData>({
    hostname: '127.0.0.1',
    port: 0,
    allowHalfOpen: true,
    socket: {
      binaryType: 'uint8array',
      open(socket) {
        socket.data = { queue: [], fin: false };
        state.connections += 1;
        socket.write(payload);
        socket.end();
      },
      data() {},
    },
  });
  return {
    port: server.port,
    get connections() {
      return state.connections;
    },
    stop: () => server.stop(true),
  };
}
