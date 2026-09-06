import type { Socket } from 'node:net';
import { halfCloseSupported, shutdownWriteHalf } from './half-close';
import { type PumpSocket, type PumpSocketData, disposePumpSocketData, onSocketData } from './pump';
import { socketHandle, watchSocketLiveness } from './socket-liveness';

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // 已经关闭
  }
}

export function destroySocket(socket: Socket): void {
  quietly(() => socket.destroy());
}

/**
 * Bun 1.3.14 会忽略 `createServer` / `connect` 上的 `allowHalfOpen` 选项（accept 出来的 socket
 * 读回来仍是 false），只有逐个 socket 打标才生效；不打标时对端的 FIN 会直接把整条 socket 销毁。
 */
export function prepareSocket(socket: Socket): void {
  socket.allowHalfOpen = true;
  quietly(() => socket.setNoDelay(true));
}

/**
 * 两侧共用的 socket 事件接线。拨号还没完成时收到的第一块数据会立刻停读：多余的字节留在内核
 * 缓冲里由 TCP 自己背压，程序内最多只压一块。在此之前不停读，是为了让「连上就走」的客户端仍能
 * 立刻被发现。
 */
export function attachPumpSocketHandlers(socket: Socket, data: PumpSocketData): void {
  const unwatch = watchSocketLiveness(socket, () => losePeer(socket, data));
  socket.on('data', (chunk: Buffer) => {
    if (!data.pump) socket.pause();
    if (!onSocketData(data, chunk)) destroySocket(socket);
  });
  socket.on('drain', () => data.pump?.onDrain());
  socket.on('end', () => {
    // 对端 RST 时 Bun 的 net 壳同样只报 end，但底层句柄已经没了；照半关闭处理会把名额挂死
    if (!socketHandle(socket)) {
      unwatch();
      losePeer(socket, data);
      return;
    }
    data.fin = true;
    data.pump?.onEnd();
  });
  socket.on('close', () => {
    unwatch();
    data.closed = true;
    data.pump?.onClose();
    disposePumpSocketData(data);
  });
  // node 在 error 之后一定会再发 close，这里只是防止未处理的 error 事件抛出去
  socket.on('error', () => {});
}

/**
 * 对端已经不在了。只调 `onClose()` 不够：它的 `localFin` / `streamEnded` 判断会把 RST 吞掉，
 * 于是半关闭过的流会永远挂在那儿。必须直接 destroy 泵（RST 掉流）再拆 socket、归还名额。
 */
function losePeer(socket: Socket, data: PumpSocketData): void {
  data.closed = true;
  data.pump?.destroy('portmap-peer-gone');
  destroySocket(socket);
  disposePumpSocketData(data);
}

/**
 * 把 node:net socket 适配成泵要的形状。写半边关闭走 POSIX `shutdown(fd, SHUT_WR)`——
 * `socket.end()` 在 Bun 上仍然会把读半边一起带走。FFI 直接作用于 fd，绕过了 node 的写队列，
 * 所以必须等排队的写全部落盘之后再关。
 */
export function netPumpSocket(socket: Socket): PumpSocket {
  let inflight = 0;
  const flushWaiters: Array<() => void> = [];
  const runWaiters = (): void => {
    for (const fn of flushWaiters.splice(0)) fn();
  };
  const settle = (): void => {
    inflight -= 1;
    if (inflight <= 0) runWaiters();
  };
  socket.on('close', () => {
    inflight = 0;
    runWaiters();
  });
  return {
    write(data) {
      if (socket.destroyed) return false;
      inflight += 1;
      return socket.write(data, settle);
    },
    endWrite() {
      const shutdown = (): void => {
        const handle = socketHandle(socket);
        if (halfCloseSupported() && handle && shutdownWriteHalf(handle)) return;
        quietly(() => socket.end());
      };
      if (inflight === 0) {
        shutdown();
        return;
      }
      flushWaiters.push(shutdown);
    },
    close: () => quietly(() => socket.end()),
    terminate: () => destroySocket(socket),
    pause: () => quietly(() => socket.pause()),
    resume: () => quietly(() => socket.resume()),
  };
}
