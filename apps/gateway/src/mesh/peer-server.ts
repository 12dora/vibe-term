import type { LinkSession } from '@tmex/shared/link';
import { defaultScheduler } from './ctl';
import { openWebSocketLink, wrapBunPeerSocket } from './peer-protocol';
import type { MeshScheduler } from './types';

export const PEER_HANDSHAKE_RATE_LIMIT = 10;
export const PEER_HANDSHAKE_RATE_WINDOW_MS = 60_000;

type PeerSocketData = {
  adapter: ReturnType<typeof wrapBunPeerSocket>;
  ip: string;
};

export type PeerServerOptions = {
  port: number;
  hostname?: string | string[];
  onAccept: (link: LinkSession, remoteIp: string) => void;
  handshakeLimitPerMin?: number;
  scheduler?: MeshScheduler;
};

class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export class PeerServer {
  private readonly opts: PeerServerOptions;
  private readonly limiter: SlidingWindowLimiter;
  private servers: Array<ReturnType<typeof Bun.serve<PeerSocketData>>> = [];

  constructor(opts: PeerServerOptions) {
    this.opts = opts;
    const scheduler = opts.scheduler ?? defaultScheduler();
    this.limiter = new SlidingWindowLimiter(
      opts.handshakeLimitPerMin ?? PEER_HANDSHAKE_RATE_LIMIT,
      PEER_HANDSHAKE_RATE_WINDOW_MS,
      () => scheduler.now()
    );
  }

  get port(): number {
    return this.servers[0]?.port ?? this.opts.port;
  }

  async start(): Promise<{ port: number; urls: string[] }> {
    if (this.servers.length > 0) {
      return this.snapshot();
    }
    const hosts = this.opts.hostname
      ? Array.isArray(this.opts.hostname)
        ? this.opts.hostname
        : [this.opts.hostname]
      : ['::', '0.0.0.0'];
    let port = this.opts.port;
    for (const hostname of hosts) {
      try {
        const server = this.listen(hostname, port);
        this.servers.push(server);
        if (port === 0) {
          const assigned = server.port;
          if (assigned === undefined) {
            throw new Error('peer server bound without a port');
          }
          port = assigned;
        }
      } catch (err) {
        if (this.servers.length > 0) {
          continue;
        }
        throw err;
      }
    }
    if (this.servers.length === 0) {
      throw new Error('failed to bind peer server');
    }
    return this.snapshot();
  }

  stop(): void {
    for (const server of this.servers) {
      try {
        server.stop(true);
      } catch {
        // already stopped
      }
    }
    this.servers = [];
  }

  private snapshot(): { port: number; urls: string[] } {
    const port = this.port;
    const urls = this.servers.map((server) => {
      const hostname = server.hostname ?? '127.0.0.1';
      const host = hostname.includes(':') ? `[${hostname}]` : hostname;
      return `ws://${host}:${server.port}/peer`;
    });
    return { port, urls };
  }

  private listen(hostname: string, port: number) {
    const onAccept = this.opts.onAccept;
    const limiter = this.limiter;
    return Bun.serve<PeerSocketData>({
      hostname,
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname !== '/peer') {
          return new Response('Not Found', { status: 404 });
        }
        const ip = server.requestIP(req)?.address ?? 'unknown';
        if (!limiter.allow(ip)) {
          return new Response('Too Many Requests', { status: 429 });
        }
        const upgraded = server.upgrade(req, {
          data: {
            adapter: null as unknown as PeerSocketData['adapter'],
            ip,
          },
        });
        if (!upgraded) {
          return new Response('Upgrade failed', { status: 500 });
        }
        return undefined as unknown as Response;
      },
      websocket: {
        open: (ws) => {
          const adapter = wrapBunPeerSocket(ws);
          ws.data.adapter = adapter;
          const link = openWebSocketLink(adapter, 'acceptor');
          onAccept(link, ws.data.ip);
        },
        message: (ws, message) => {
          ws.data.adapter?.ingestMessage(message);
        },
        drain: (ws) => {
          ws.data.adapter?.ingestDrain();
        },
        close: (ws) => {
          ws.data.adapter?.ingestClose('ws-closed');
        },
      },
    });
  }
}
