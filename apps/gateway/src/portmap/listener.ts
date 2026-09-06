import { encodeJsonBytes } from '../mesh/ctl';
import type { TcpStreamOpenPayload } from '../mesh/types';
import {
  type PumpSocketData,
  TcpStreamPump,
  attachPump,
  createPumpSocketData,
  onSocketData,
} from './pump';
import {
  PORT_MAP_MAX_CONNECTIONS,
  type PortMapCounters,
  PortMapError,
  type PortMapPeers,
  type PortMapRow,
} from './types';

export type PortMapListenerOptions = {
  row: PortMapRow;
  peers: () => PortMapPeers | null;
  counters: PortMapCounters;
  maxConnections?: number;
};

type MapSocket = Bun.Socket<PumpSocketData>;

/** A 侧监听端：每条本地连接懒拨一次 peer 链路并开一条 tcp 流，链路断了就关连接，不重放。 */
export class PortMapListener {
  private readonly row: PortMapRow;
  private readonly peers: () => PortMapPeers | null;
  private readonly counters: PortMapCounters;
  private readonly maxConnections: number;
  private readonly sockets = new Set<MapSocket>();
  private server: Bun.TCPSocketListener<PumpSocketData> | null = null;
  private stopped = false;

  constructor(opts: PortMapListenerOptions) {
    this.row = opts.row;
    this.peers = opts.peers;
    this.counters = opts.counters;
    this.maxConnections = opts.maxConnections ?? PORT_MAP_MAX_CONNECTIONS;
  }

  start(): void {
    if (this.server) return;
    this.stopped = false;
    try {
      this.server = Bun.listen<PumpSocketData>({
        hostname: this.row.listenHost,
        port: this.row.listenPort,
        allowHalfOpen: true,
        socket: {
          binaryType: 'uint8array',
          open: (socket) => this.onOpen(socket),
          data: (socket, chunk) => {
            if (!onSocketData(socket.data, chunk as unknown as Uint8Array)) {
              socket.terminate();
            }
          },
          drain: (socket) => socket.data.pump?.onDrain(),
          end: (socket) => {
            socket.data.fin = true;
            socket.data.pump?.onEnd();
          },
          close: (socket) => this.onClose(socket),
          error: (socket) => this.onClose(socket),
        },
      });
    } catch (err) {
      throw new PortMapError(
        'bind_failed',
        `failed to bind ${this.row.listenHost}:${this.row.listenPort}: ${
          err instanceof Error ? err.message : 'bind failed'
        }`
      );
    }
  }

  stop(): void {
    this.stopped = true;
    const server = this.server;
    this.server = null;
    try {
      server?.stop(true);
    } catch {
      // 已经关闭
    }
    for (const socket of [...this.sockets]) {
      socket.data?.pump?.destroy('portmap-stopped');
      try {
        socket.terminate();
      } catch {
        // 已经关闭
      }
    }
    this.sockets.clear();
    this.counters.activeConnections = 0;
  }

  private onOpen(socket: MapSocket): void {
    socket.data = createPumpSocketData();
    if (this.stopped || this.sockets.size >= this.maxConnections) {
      try {
        socket.terminate();
      } catch {
        // 已经关闭
      }
      return;
    }
    this.sockets.add(socket);
    this.counters.activeConnections = this.sockets.size;
    this.counters.totalConnections += 1;
    try {
      socket.setNoDelay(true);
    } catch {
      // 不支持就算了
    }
    void this.dial(socket);
  }

  private onClose(socket: MapSocket): void {
    if (socket.data) {
      socket.data.closed = true;
      socket.data.pump?.onClose();
    }
    if (this.sockets.delete(socket)) this.counters.activeConnections = this.sockets.size;
  }

  private async dial(socket: MapSocket): Promise<void> {
    try {
      const peers = this.peers();
      if (!peers) throw new Error('mesh not ready');
      const link = await peers.getLink(this.row.targetNodeId);
      if (socket.data.closed || this.stopped) throw new Error('client gone');
      const payload: TcpStreamOpenPayload = {
        type: 'tcp',
        mapId: this.row.id,
        host: this.row.targetHost,
        port: this.row.targetPort,
      };
      const stream = await link.openStream(encodeJsonBytes(payload));
      if (socket.data.closed || this.stopped) {
        stream.reset('portmap-client-gone');
        throw new Error('client gone');
      }
      attachPump(socket.data, new TcpStreamPump(socket, stream, this.counters));
    } catch {
      try {
        socket.terminate();
      } catch {
        // 已经关闭
      }
    }
  }
}
