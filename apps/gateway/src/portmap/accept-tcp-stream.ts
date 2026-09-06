import type { LinkStream } from '@tmex/shared/link';
import { parseOpenPayload } from '../mesh/peer-protocol';
import { acquirePeerStreamSlot } from './budget';
import { type TcpDial, dialTcp } from './dial';
import {
  type PumpSocketData,
  TcpStreamPump,
  attachPump,
  bunPumpSocket,
  createPumpSocketData,
  disposePumpSocketData,
} from './pump';
import { pumpSocketHandlers } from './socket-handlers';
import type { PortMapExportStoreLike } from './store';
import {
  PORT_MAP_CONNECT_TIMEOUT_MS,
  PORT_MAP_MAX_PEER_STREAMS,
  type PortMapExportRow,
  createPortMapCounters,
} from './types';

export type AcceptTcpStreamContext = {
  peerNodeId: string;
  exports: PortMapExportStoreLike;
  connectTimeoutMs?: number;
  peerStreamLimit?: number;
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

function startDial(
  row: PortMapExportRow,
  data: PumpSocketData,
  timeoutMs: number
): TcpDial<PumpSocketData> {
  return dialTcp<PumpSocketData>(
    {
      hostname: row.host,
      port: row.port,
      allowHalfOpen: true,
      data,
      socket: pumpSocketHandlers((socket) => {
        try {
          socket.setNoDelay(true);
        } catch {
          // 不支持就算了
        }
      }),
    },
    timeoutMs
  );
}

/**
 * B 侧入口：校验放行记录、占用本对端的并发名额后拨号本机目标端口，接上双向泵。
 * 名额在 socket 真正处置掉时才归还——流被 RST 之后底层连接尝试可能还在，不能提前放行。
 */
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
  const slot = acquirePeerStreamSlot(
    ctx.peerNodeId,
    ctx.peerStreamLimit ?? PORT_MAP_MAX_PEER_STREAMS
  );
  if (!slot) {
    stream.reset('portmap-peer-limit');
    return;
  }
  const data = createPumpSocketData();
  data.onDisposed = () => slot.release();
  // 中断处理必须先于拨号注册：流被 RST 时要立刻取消底层连接
  let dial: TcpDial<PumpSocketData> | null = null;
  let aborted = false;
  stream.onAbort(() => {
    aborted = true;
    dial?.cancel();
  });
  if (aborted) {
    disposePumpSocketData(data);
    return;
  }
  dial = startDial(row, data, ctx.connectTimeoutMs ?? PORT_MAP_CONNECT_TIMEOUT_MS);
  if (aborted) dial.cancel();
  let socket: Bun.Socket<PumpSocketData>;
  try {
    socket = await dial.result;
  } catch {
    stream.reset('portmap-connect-failed');
    disposePumpSocketData(data);
    return;
  }
  attachPump(data, new TcpStreamPump(bunPumpSocket(socket), stream, createPortMapCounters()));
}
