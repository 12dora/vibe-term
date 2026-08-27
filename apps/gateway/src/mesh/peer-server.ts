import type { ServerSocketAdapter } from '@tmex/shared/link';
import { defaultScheduler } from './ctl';
import { wrapBunPeerSocket } from './peer-protocol';
import type { MeshScheduler } from './types';

export const PEER_HANDSHAKE_RATE_LIMIT = 10;
export const PEER_HANDSHAKE_RATE_WINDOW_MS = 60_000;
export const PEER_RATE_LIMIT_MAX_KEYS = 4096;

type PeerSocketData = {
  adapter: ReturnType<typeof wrapBunPeerSocket>;
  ip: string;
};

export type PeerServerOptions = {
  port: number;
  hostname?: string | string[];
  onAccept: (socket: ServerSocketAdapter, remoteIp: string) => void;
  handshakeLimitPerMin?: number;
  scheduler?: MeshScheduler;
};

export function isWebSocketUpgradeRequest(req: Request): boolean {
  const upgrade = req.headers.get('upgrade')?.toLowerCase();
  const connection = req.headers.get('connection')?.toLowerCase() ?? '';
  return upgrade === 'websocket' && connection.includes('upgrade');
}

class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys: number
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs && this.hits.size <= this.maxKeys) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
    while (this.hits.size > this.maxKeys) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, times] of this.hits) {
        const first = times[0] ?? Number.POSITIVE_INFINITY;
        if (first < oldest) {
          oldest = first;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.hits.delete(oldestKey);
    }
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
      () => scheduler.now(),
      PEER_RATE_LIMIT_MAX_KEYS
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
    const errors: string[] = [];
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
        errors.push(`${hostname}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.servers.length === 0) {
      throw new Error(`failed to bind peer server: ${errors.join('; ')}`);
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
        if (!isWebSocketUpgradeRequest(req)) {
          return new Response('Upgrade Required', { status: 426 });
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
          onAccept(adapter, ws.data.ip);
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
