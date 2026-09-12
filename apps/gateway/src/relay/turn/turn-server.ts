import type dgram from 'node:dgram';
import { AllocationTable } from './allocation-table';
import { DEFAULT_DENIED_PEER_CIDRS, createPeerPolicy } from './denied-peers';
import type { TurnServer, TurnServerOptions, TurnServerStats } from './index';
import { resolveTurnListenHost } from './local-address';
import { decodeMessage, isChannelData, verifyFingerprint } from './stun-message';
import { NonceStore } from './turn-auth';
import type { MutableStats, ResolvedTurnOptions, SocketAddress, TurnContext } from './turn-context';
import { dispatchStun } from './turn-dispatch';
import {
  DEFAULT_MAX_ALLOCATIONS,
  DEFAULT_MAX_ALLOCATIONS_PER_USER,
  DEFAULT_MAX_LIFETIME_SEC,
  HOUSEKEEPING_MS,
  MAX_UDP_PACKET,
} from './turn-limits';
import { guardTurnHandler, handleClientChannelData } from './turn-relay-io';
import { closeSocket, listenUdpOrWildcard } from './turn-udp';
import { UnauthResponseLimiter } from './turn-unauth-limit';

class TurnServerImpl implements TurnServer {
  private control: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly ctx: TurnContext;

  constructor(options: TurnServerOptions) {
    const resolved = resolveOptions(options);
    const stats = emptyStats(options.listenPort, options.externalIp, resolved.listenHost);
    this.ctx = {
      options: resolved,
      stats,
      table: new AllocationTable(resolved),
      nonce: new NonceStore(resolved.now),
      unauthLimit: new UnauthResponseLimiter(resolved.now),
      denied: createPeerPolicy(resolved.deniedPeerCidrs),
      send: (buf, addr) => {
        this.control?.send(buf, addr.port, addr.address);
      },
    };
  }

  async start(): Promise<{ port: number }> {
    if (this.started && this.control) return { port: this.ctx.stats.port };
    const resolved = await resolveTurnListenHost(this.ctx.options.listenHost, {
      warn: (line) => this.ctx.options.log(line),
    });
    this.ctx.options.listenHost = resolved;
    this.ctx.stats.bindHost = resolved;
    const bound = await listenUdpOrWildcard(this.ctx.options.listenPort, resolved, (line) =>
      this.ctx.options.log(line)
    );
    this.ctx.options.listenHost = bound.host;
    this.ctx.stats.bindHost = bound.host;
    this.attachControl(bound.socket);
    return { port: this.ctx.stats.port };
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.ctx.table.closeAll();
    const control = this.control;
    this.control = null;
    this.started = false;
    this.ctx.stats.listening = false;
    await closeSocket(control);
  }

  snapshot(): TurnServerStats {
    this.ctx.table.expireAll();
    const counts = this.ctx.table.counts();
    return { ...this.ctx.stats, ...counts, listening: this.started };
  }

  setExternalIp(ip: string): void {
    const next = ip.trim();
    if (!next || next === this.ctx.options.externalIp) return;
    this.ctx.options.externalIp = next;
    this.ctx.stats.externalIp = next;
    this.ctx.options.log(`turn: external ip ${next}`);
  }

  private attachControl(socket: dgram.Socket): void {
    this.control = socket;
    socket.on('message', (buf, rinfo) => {
      guardTurnHandler(this.ctx, () => this.onMessage(buf, rinfo));
    });
    socket.on('error', (err) => this.ctx.options.log(`turn: control ${err.message}`));
    this.started = true;
    const port = socket.address().port;
    this.ctx.stats.port = port;
    this.ctx.stats.listening = true;
    this.ctx.stats.startedAt = this.ctx.options.now();
    this.timer = setInterval(() => this.ctx.table.expireAll(), HOUSEKEEPING_MS);
    this.timer.unref();
    this.ctx.stats.bindHost = this.ctx.options.listenHost;
    this.ctx.options.log(
      `turn: listening ${this.ctx.options.listenHost}:${port} bind=${this.ctx.options.listenHost}`
    );
  }

  private onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    this.dispatchDatagram(buf, { address: rinfo.address, port: rinfo.port });
  }

  private dispatchDatagram(buf: Buffer, addr: SocketAddress): void {
    if (buf.length > MAX_UDP_PACKET) return;
    this.ctx.table.expireAll();
    if (isChannelData(buf)) {
      handleClientChannelData(this.ctx, buf, addr);
      return;
    }
    const msg = decodeMessage(buf);
    if (!msg || !verifyFingerprint(msg)) return;
    dispatchStun(this.ctx, msg, addr);
  }
}

export function createTurnServer(options: TurnServerOptions): TurnServer {
  return new TurnServerImpl(options);
}

function resolveOptions(options: TurnServerOptions): ResolvedTurnOptions {
  return {
    listenHost: options.listenHost ?? 'auto',
    listenPort: options.listenPort,
    relayPortRange: options.relayPortRange,
    externalIp: options.externalIp,
    realm: options.realm,
    credentials: options.credentials,
    maxAllocations: options.maxAllocations ?? DEFAULT_MAX_ALLOCATIONS,
    maxAllocationsPerUser: options.maxAllocationsPerUser ?? DEFAULT_MAX_ALLOCATIONS_PER_USER,
    maxLifetimeSec: options.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC,
    deniedPeerCidrs: options.deniedPeerCidrs ?? DEFAULT_DENIED_PEER_CIDRS,
    bytesPerSecPerAllocation: options.bytesPerSecPerAllocation ?? 0,
    log: options.log ?? noop,
    now: options.now ?? Date.now,
  };
}

function emptyStats(port: number, externalIp: string, bindHost: string): MutableStats {
  return {
    listening: false,
    port,
    bindHost,
    externalIp,
    allocations: 0,
    permissions: 0,
    channels: 0,
    bytesRelayedIn: 0,
    bytesRelayedOut: 0,
    authFailures: 0,
    deniedPeers: 0,
    bindingRequests: 0,
    startedAt: null,
    droppedNoPermission: 0,
    droppedRateLimit: 0,
    droppedOversized: 0,
    droppedUnauthRateLimit: 0,
  };
}

function noop(): void {}
