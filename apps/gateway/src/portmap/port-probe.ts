import { PORT_MAP_TARGET_PROBE_TIMEOUT_MS } from './types';

function closeQuietly(socket: { terminate(): void } | null): void {
  try {
    socket?.terminate();
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

/** 目标端口是否有服务在监听：连上即算，连不上或超时算否。 */
export async function isPortListening(
  host: string,
  port: number,
  timeoutMs = PORT_MAP_TARGET_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const connect = Bun.connect<undefined>({
    hostname: host,
    port,
    socket: { data() {}, error() {}, close() {} },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('portmap-probe-timeout')), timeoutMs);
  });
  try {
    const socket = await Promise.race([connect, timeout]);
    closeQuietly(socket);
    return true;
  } catch {
    // 超时的那条连接可能稍后才建立，兜底关掉，别把 fd 漏出去
    void connect.then(closeQuietly).catch(() => {});
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
