import { type Server, type Socket, createServer } from 'node:net';
import type { LinkStream } from '@vibeterm/shared/link';
import { encodeJsonBytes } from '../mesh/ctl';
import type { TcpStreamOpenPayload } from '../mesh/types';
import { type PeerStreamSlot, acquirePeerStreamSlot } from './budget';
import { withDeadline } from './dial';
import {
  type PumpSocketData,
  TcpStreamPump,
  attachPump,
  createPumpSocketData,
  disposePumpSocketData,
} from './pump';
import {
  attachPumpSocketHandlers,
  destroySocket,
  netPumpSocket,
  prepareSocket,
} from './socket-handlers';
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
  /** listen 之后异步冒出来的绑定错误（同步的那次已经在 start() 里抛了）。 */
  onBindFailed?: () => void;
};

type Conn = { socket: Socket; data: PumpSocketData };

/** A 侧监听端：每条本地连接懒拨一次 peer 链路并开一条 tcp 流，链路断了就关连接，不重放。 */
export class PortMapListener {
  private readonly row: PortMapRow;
  private readonly peers: () => PortMapPeers | null;
  private readonly counters: PortMapCounters;
  private readonly maxConnections: number;
  private readonly peerStreamLimit: number;
  private readonly dialDeadlineMs: number;
  private readonly onBindFailed: (() => void) | null;
  private readonly conns = new Set<Conn>();
  private server: Server | null = null;
  private stopped = false;

  constructor(opts: PortMapListenerOptions) {
    this.row = opts.row;
    this.peers = opts.peers;
    this.counters = opts.counters;
    this.maxConnections = opts.maxConnections ?? PORT_MAP_MAX_CONNECTIONS;
    this.peerStreamLimit = opts.peerStreamLimit ?? PORT_MAP_MAX_PEER_STREAMS;
    this.dialDeadlineMs = opts.dialDeadlineMs ?? PORT_MAP_DIAL_DEADLINE_MS;
    this.onBindFailed = opts.onBindFailed ?? null;
  }

  /**
   * node 的 `listen()` 只在事件里报错，但绑定本身是同步做完的：`address()` 立刻为 null 就说明
   * 端口被占，可以照旧同步抛 `PortMapError`；异步兜底的 error 事件走 `onBindFailed`。
   */
  start(): void {
    if (this.server) return;
    this.stopped = false;
    const server = createServer({ allowHalfOpen: true, noDelay: true });
    server.on('error', () => this.handleBindError(server));
    server.on('connection', (socket) => this.onOpen(socket));
    server.listen({ host: this.row.listenHost, port: this.row.listenPort });
    if (!server.address()) {
      try {
        server.close();
      } catch {
        // 本来就没绑上
      }
      throw new PortMapError(
        'port_in_use',
        `failed to bind ${this.row.listenHost}:${this.row.listenPort}`
      );
    }
    this.server = server;
  }

  stop(): void {
    this.stopped = true;
    const server = this.server;
    this.server = null;
    try {
      server?.close();
    } catch {
      // 已经关闭
    }
    for (const conn of [...this.conns]) {
      conn.data.pump?.destroy('portmap-stopped');
      destroySocket(conn.socket);
      disposePumpSocketData(conn.data);
    }
    this.conns.clear();
    this.counters.activeConnections = 0;
  }

  private handleBindError(server: Server): void {
    if (this.server !== server) return;
    this.server = null;
    this.onBindFailed?.();
  }

  private onOpen(socket: Socket): void {
    const data = createPumpSocketData();
    const slot =
      this.stopped || this.conns.size >= this.maxConnections
        ? null
        : acquirePeerStreamSlot(this.row.targetNodeId, this.peerStreamLimit);
    if (!slot) {
      destroySocket(socket);
      return;
    }
    const conn: Conn = { socket, data };
    this.conns.add(conn);
    data.onDisposed = () => this.release(conn, slot);
    this.counters.activeConnections = this.conns.size;
    this.counters.totalConnections += 1;
    prepareSocket(socket);
    attachPumpSocketHandlers(socket, data);
    void this.dial(conn);
  }

  private release(conn: Conn, slot: PeerStreamSlot): void {
    if (this.conns.delete(conn)) this.counters.activeConnections = this.conns.size;
    slot.release();
  }

  private async dial(conn: Conn): Promise<void> {
    try {
      const stream = await this.openStream(conn);
      attachPump(conn.data, new TcpStreamPump(netPumpSocket(conn.socket), stream, this.counters));
    } catch {
      // 先 resume 再关：拨号期间停读的 socket 否则收不到 close
      try {
        conn.socket.resume();
      } catch {
        // 已经关闭
      }
      destroySocket(conn.socket);
      disposePumpSocketData(conn.data);
    }
  }

  private async openStream(conn: Conn): Promise<LinkStream> {
    const peers = this.peers();
    if (!peers) throw new Error('mesh not ready');
    const startedAt = Date.now();
    const link = await withDeadline(
      peers.getLink(this.row.targetNodeId),
      this.dialDeadlineMs,
      () => {}
    );
    if (conn.data.closed || this.stopped) throw new Error('client gone');
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
    if (conn.data.closed || this.stopped) {
      stream.reset('portmap-client-gone');
      throw new Error('client gone');
    }
    return stream;
  }
}
