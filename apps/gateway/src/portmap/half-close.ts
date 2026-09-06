import { openLibc } from './libc';

/**
 * Bun 1.3.14 没有可用的写半边关闭：`Bun.Socket.end()` 会立刻摘掉本地句柄（readyState 变 -1，
 * 读半边一起消失），`socket.shutdown(true)` 更糟——只触发自己的 `end` 回调，对端收不到 FIN；
 * node:net 的 `socket.end()` 同样两半一起关。所以直接调 POSIX 的 `shutdown(fd, SHUT_WR)`，
 * 取不到就退回整条关闭。
 * 传进来的对象要带 `fd` 与 `readyState`：Bun socket 本身，或 node:net socket 的 `_handle`。
 */
const SHUT_WR = 1;

type ShutdownFn = (fd: number, how: number) => number;

let shutdownFn: ShutdownFn | null | undefined;

function loadShutdown(): ShutdownFn | null {
  const libc = openLibc((t) => ({ shutdown: { args: [t.i32, t.i32], returns: t.i32 } }));
  const symbol = libc?.symbols.shutdown;
  if (!symbol) return null;
  return (fd, how) => symbol(fd as never, how as never);
}

/** FFI 能否加载出来；加载不到就只能整条关闭。 */
export function halfCloseSupported(): boolean {
  if (shutdownFn === undefined) shutdownFn = loadShutdown();
  return shutdownFn !== null;
}

function socketFd(socket: unknown): number {
  const fd = (socket as { fd?: unknown }).fd;
  return typeof fd === 'number' && Number.isInteger(fd) && fd >= 0 ? fd : -1;
}

/**
 * 关闭写半边、保留读半边。返回 false 表示当前环境做不到，调用方应退回 `socket.end()`。
 * 只在 socket 仍处于 Established 时动手：已关闭的 fd 可能已被别的连接复用。
 */
export function shutdownWriteHalf(socket: { readyState: number }): boolean {
  if (socket.readyState !== 1) return false;
  const fd = socketFd(socket);
  if (fd < 0) return false;
  if (!halfCloseSupported() || !shutdownFn) return false;
  try {
    return shutdownFn(fd, SHUT_WR) === 0;
  } catch {
    return false;
  }
}
