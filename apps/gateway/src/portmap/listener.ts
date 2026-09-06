import type { LinkStream } from '@tmex/shared/link';
import { encodeJsonBytes } from '../mesh/ctl';
import type { TcpStreamOpenPayload } from '../mesh/types';
import { type PeerStreamSlot, acquirePeerStreamSlot } from './budget';
import { withDeadline } from './dial';
import {
  type PumpSocketData,
  TcpStreamPump,
  attachPump,
  bunPumpSocket,
  createPumpSocketData,
  disposePumpSocketData,
} from './pump';
import { pumpSocketHandlers } from './socket-handlers';
import {
  PORT_MAP_DIAL_DEADLINE_MS,
  PORT_MAP_MAX_CONNECTIONS,
  PORT_MAP_MAX_PEER_STREAMS,
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
  peerStreamLimit?: number;
  dialDeadlineMs?: number;
};

type MapSocket = Bun.Socket<PumpSocketData>;

/** A 侧监听端：每条本地连接懒拨一次 peer 链路并开一条 tcp 流，链路断了就关连接，不重放。 */
export class PortMapListener {
  private readonly row: PortMapRow;
  private readonly peers: () => PortMapPeers | null;
  private readonly counters: PortMapCounters;
  private readonly maxConnections: number;
  private readonly peerStreamLimit: number;
  private readonly dialDeadlineMs: number;
  private readonly sockets = new Set<MapSocket>();
  private server: Bun.TCPSocketListener<PumpSocketData> | null = null;
  private stopped = false;

  constructor(opts: PortMapListenerOptions) {
    this.row = opts.row;
    this.peers = opts.peers;
    this.counters = opts.counters;
    this.maxConnections = opts.maxConnections ?? PORT_MAP_MAX_CONNECTIONS;
    this.peerStreamLimit = opts.peerStreamLimit ?? PORT_MAP_MAX_PEER_STREAMS;
    this.dialDeadlineMs = opts.dialDeadlineMs ?? PORT_MAP_DIAL_DEADLINE_MS;
  }

  start(): void {
    if (this.server) return;
    this.stopped = false;
    try {
      this.server = Bun.listen<PumpSocketData>({
        hostname: this.row.listenHost,
        port: this.row.listenPort,
        allowHalfOpen: true,
        socket: pumpSocketHandlers((socket) => this.onOpen(socket)),
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
      if (socket.data) disposePumpSocketData(socket.data);
    }
    this.sockets.clear();
    this.counters.activeConnections = 0;
  }

  private onOpen(socket: MapSocket): void {
    socket.data = createPumpSocketData();
    const slot =
      this.stopped || this.sockets.size >= this.maxConnections
        ? null
        : acquirePeerStreamSlot(this.row.targetNodeId, this.peerStreamLimit);
    if (!slot) {
      try {
        socket.terminate();
      } catch {
        // 已经关闭
      }
      return;
    }
    this.sockets.add(socket);
    socket.data.onDisposed = () => this.release(socket, slot);
    this.counters.activeConnections = this.sockets.size;
    this.counters.totalConnections += 1;
    try {
      socket.setNoDelay(true);
    } catch {
      // 不支持就算了
    }
    void this.dial(socket);
  }

  private release(socket: MapSocket, slot: PeerStreamSlot): void {
    if (this.sockets.delete(socket)) this.counters.activeConnections = this.sockets.size;
    slot.release();
  }

  private async dial(socket: MapSocket): Promise<void> {
    try {
      const stream = await this.openStream(socket);
      attachPump(socket.data, new TcpStreamPump(bunPumpSocket(socket), stream, this.counters));
    } catch {
      // 先 resume 再关：被 pause 压住的 close 事件否则出不来
      try {
        socket.resume();
        socket.terminate();
      } catch {
        // 已经关闭
      }
      disposePumpSocketData(socket.data);
    }
  }

  private async openStream(socket: MapSocket): Promise<LinkStream> {
    const peers = this.peers();
    if (!peers) throw new Error('mesh not ready');
    const startedAt = Date.now();
    const link = await withDeadline(
      peers.getLink(this.row.targetNodeId),
      this.dialDeadlineMs,
      () => {}
    );
    if (socket.data.closed || this.stopped) throw new Error('client gone');
    const payload: TcpStreamOpenPayload = {
      type: 'tcp',
      mapId: this.row.id,
      host: this.row.targetHost,
      port: this.row.targetPort,
    };
    const remaining = Math.max(1, this.dialDeadlineMs - (Date.now() - startedAt));
    const stream = await withDeadline(
      link.openStream(encodeJsonBytes(payload)),
      remaining,
      (late) => late.reset('portmap-dial-timeout')
    );
    if (socket.data.closed || this.stopped) {
      stream.reset('portmap-client-gone');
      throw new Error('client gone');
    }
    return stream;
  }
}
