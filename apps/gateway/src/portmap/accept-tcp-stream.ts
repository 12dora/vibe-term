import type { LinkStream } from '@tmex/shared/link';
import { parseOpenPayload } from '../mesh/peer-protocol';
import {
  type PumpSocketData,
  TcpStreamPump,
  attachPump,
  createPumpSocketData,
  onSocketData,
} from './pump';
import type { PortMapExportStoreLike } from './store';
import { PORT_MAP_CONNECT_TIMEOUT_MS, type PortMapExportRow, createPortMapCounters } from './types';

export type AcceptTcpStreamContext = {
  peerNodeId: string;
  exports: PortMapExportStoreLike;
  connectTimeoutMs?: number;
};

type Requested = { mapId: string; host: string; port: number };

function parseRequest(stream: LinkStream): Requested | null {
  const open = parseOpenPayload(stream.openPayload);
  if (!open || open.type !== 'tcp') return null;
  const { mapId, host, port } = open;
  if (typeof mapId !== 'string' || !mapId) return null;
  if (typeof host !== 'string' || !host) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { mapId, host, port };
}

/** 放行必须三项全中：映射 id 存在、来源节点即握手认证的对端、且未停用。 */
function allows(row: PortMapExportRow | null, peerNodeId: string, req: Requested): boolean {
  if (!row || !row.enabled) return false;
  if (row.fromNodeId !== peerNodeId) return false;
  return row.host === req.host && row.port === req.port;
}

async function connectWithTimeout(
  row: PortMapExportRow,
  data: PumpSocketData,
  timeoutMs: number
): Promise<Bun.Socket<PumpSocketData>> {
  const connect = Bun.connect<PumpSocketData>({
    hostname: row.host,
    port: row.port,
    allowHalfOpen: true,
    data,
    socket: {
      binaryType: 'uint8array',
      open(socket) {
        try {
          socket.setNoDelay(true);
        } catch {
          // 不支持就算了
        }
      },
      data(socket, chunk) {
        if (!onSocketData(socket.data, chunk as unknown as Uint8Array)) socket.terminate();
      },
      drain(socket) {
        socket.data.pump?.onDrain();
      },
      end(socket) {
        socket.data.fin = true;
        socket.data.pump?.onEnd();
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.pump?.onClose();
      },
      error(socket) {
        socket.data.closed = true;
        socket.data.pump?.onClose();
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('portmap-connect-timeout')), timeoutMs);
  });
  try {
    return await Promise.race([connect, timeout]);
  } catch (err) {
    void connect
      .then((socket) => {
        try {
          socket.terminate();
        } catch {
          // 已经关闭
        }
      })
      .catch(() => {});
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** B 侧入口：校验放行记录后拨号本机目标端口，接上双向泵。 */
export async function acceptTcpStream(
  stream: LinkStream,
  ctx: AcceptTcpStreamContext
): Promise<void> {
  const req = parseRequest(stream);
  if (!req) {
    stream.reset('portmap-invalid-payload');
    return;
  }
  const row = ctx.exports.get(req.mapId);
  if (!allows(row, ctx.peerNodeId, req) || !row) {
    stream.reset('portmap-forbidden');
    return;
  }
  const data = createPumpSocketData();
  let socket: Bun.Socket<PumpSocketData>;
  try {
    socket = await connectWithTimeout(
      row,
      data,
      ctx.connectTimeoutMs ?? PORT_MAP_CONNECT_TIMEOUT_MS
    );
  } catch {
    stream.reset('portmap-connect-failed');
    return;
  }
  attachPump(data, new TcpStreamPump(socket, stream, createPortMapCounters()));
}
