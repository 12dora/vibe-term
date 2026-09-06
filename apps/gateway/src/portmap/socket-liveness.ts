import type { Socket } from 'node:net';
import { type Libc, openLibc } from './libc';

/**
 * Bun 1.3.14 的 node:net 壳不会为对端异常断开发出 `error`/`close`，读半边 EOF 也只在 socket
 * 处于流动状态时才冒出来。于是「被暂停的 socket 对端 RST 了」「对端先 FIN 再 RST」这两种情况
 * 完全没有事件，连接、并发名额与 mux 流会一直挂着。这里用一个共享的秒级巡检补上：
 *
 * - `_handle` 消失（Bun 自己拆掉了原生 socket，实测 `Bun.Socket.terminate()` 打过来就是这样）；
 * - `_handle.readyState` 不再是 Established；
 * - 内核的 `SO_ERROR` 非 0（实测真实 RST 走这条，句柄和 readyState 都还在）。
 *
 * `SO_ERROR` 读一次即被清空，所以只在准备拆连接时读——读到非 0 就立刻判定这条连接已死。
 */
const POLL_INTERVAL_MS = 1_000;
const SOL_SOCKET = process.platform === 'darwin' ? 0xffff : 1;
const SO_ERROR = process.platform === 'darwin' ? 0x1007 : 4;

export type SocketHandle = { readyState: number; fd: number };

export function socketHandle(socket: Socket): SocketHandle | null {
  return (socket as Socket & { _handle?: SocketHandle | null })._handle ?? null;
}

let libc: Libc | null | undefined;

function peerErrorReader(): Libc | null {
  if (libc === undefined) {
    libc = openLibc((t) => ({
      getsockopt: { args: [t.i32, t.i32, t.i32, t.ptr, t.ptr], returns: t.i32 },
    }));
  }
  return libc;
}

/** 取并清空内核挂在这条 socket 上的错误码；取不到（无 FFI）一律当作 0。 */
export function socketPeerError(fd: number): number {
  const lib = peerErrorReader();
  const symbol = lib?.symbols.getsockopt;
  if (!lib || !symbol) return 0;
  const value = new Int32Array(1);
  const length = new Int32Array([4]);
  try {
    const rc = symbol(
      fd as never,
      SOL_SOCKET as never,
      SO_ERROR as never,
      lib.ptr(value) as never,
      lib.ptr(length) as never
    );
    return rc === 0 ? (value[0] as number) : 0;
  } catch {
    return 0;
  }
}

/** 连接是否还活着。只在巡检里调用：它会顺带清掉 `SO_ERROR`。 */
export function isSocketAlive(socket: Socket): boolean {
  const handle = socketHandle(socket);
  if (!handle || handle.readyState !== 1) return false;
  return socketPeerError(handle.fd) === 0;
}

const watched = new Map<Socket, () => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (watched.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
}

/** 巡检一轮；测试里直接调用它，免得等定时器。 */
export function scanSocketLiveness(): void {
  for (const [socket, onLost] of [...watched]) {
    // 已经 destroy 的 socket 后面必有 close 事件，走正常收尾即可
    if (socket.destroyed) {
      watched.delete(socket);
      continue;
    }
    if (isSocketAlive(socket)) continue;
    watched.delete(socket);
    onLost();
  }
  stopTimer();
}

export function watchSocketLiveness(socket: Socket, onLost: () => void): () => void {
  watched.set(socket, onLost);
  if (!timer) {
    timer = setInterval(scanSocketLiveness, POLL_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return () => {
    watched.delete(socket);
    stopTimer();
  };
}

/** 仅供测试。 */
export function watchedSocketCount(): number {
  return watched.size;
}
