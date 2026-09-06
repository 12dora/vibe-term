import { type PumpSocketData, disposePumpSocketData, onSocketData } from './pump';

function finish(socket: Bun.Socket<PumpSocketData>): void {
  const data = socket.data;
  if (!data) return;
  data.closed = true;
  data.pump?.onClose();
  disposePumpSocketData(data);
}

/**
 * 两侧共用的 Bun socket 回调。拨号还没完成时收到的第一块数据会立刻把 socket 停读：多余的字节留在
 * 内核缓冲里由 TCP 自己背压，程序内最多只压一块。在此之前不 pause，是为了让「客户端连上就走」
 * 这种常见情况仍能立刻收到 close——Bun 的 pause 会把 data/end/close 一起压住。
 */
export function pumpSocketHandlers(
  open: (socket: Bun.Socket<PumpSocketData>) => void
): Bun.SocketHandler<PumpSocketData> {
  return {
    binaryType: 'uint8array',
    open,
    data(socket, chunk) {
      const data = socket.data;
      if (!data) return;
      if (!data.pump) socket.pause();
      if (!onSocketData(data, chunk)) socket.terminate();
    },
    drain(socket) {
      socket.data?.pump?.onDrain();
    },
    end(socket) {
      const data = socket.data;
      if (!data) return;
      data.fin = true;
      data.pump?.onEnd();
    },
    close(socket) {
      finish(socket);
    },
    error(socket) {
      finish(socket);
    },
  };
}
