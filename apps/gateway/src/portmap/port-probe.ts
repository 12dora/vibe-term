import { dialTcp } from './dial';
import { PORT_MAP_TARGET_PROBE_TIMEOUT_MS } from './types';

function closeQuietly(socket: { terminate(): void }): void {
  try {
    socket.terminate();
  } catch {
    // 已经关闭
  }
}

/** 绑定再立刻释放：能绑上即视为空闲。不做重试，调用方拿到 false 就报端口占用。 */
export function isPortFree(host: string, port: number): boolean {
  let listener: { stop: (closeActiveConnections?: boolean) => void } | null = null;
  try {
    listener = Bun.listen({ hostname: host, port, socket: { data() {} } });
    return true;
  } catch {
    return false;
  } finally {
    try {
      listener?.stop(true);
    } catch {
      // 已经释放
    }
  }
}

/** 目标端口是否有服务在监听：连上即算，连不上或超时算否（超时的连接由 dialTcp 收拾）。 */
export async function isPortListening(
  host: string,
  port: number,
  timeoutMs = PORT_MAP_TARGET_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const dial = dialTcp<undefined>(
    { hostname: host, port, socket: { data() {}, error() {}, close() {} } },
    timeoutMs
  );
  try {
    closeQuietly(await dial.result);
    return true;
  } catch {
    return false;
  }
}
