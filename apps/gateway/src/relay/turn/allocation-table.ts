import type dgram from 'node:dgram';
import { normalizePeerAddress } from './denied-peers';
import type { SocketAddress } from './turn-context';
import {
  CHANNEL_LIFETIME_MS,
  MAX_PERMISSIONS_PER_ALLOCATION,
  PERMISSION_LIFETIME_MS,
} from './turn-limits';
import { bindUdpResult, closeSocket } from './turn-udp';

export type Permission = {
  address: string;
  port: number;
  expiresAt: number;
};

export type ChannelBinding = {
  number: number;
  address: string;
  port: number;
  peerKey: string;
  expiresAt: number;
};

export type Allocation = {
  key: string;
  user: string;
  password: string;
  client: SocketAddress;
  socket: dgram.Socket;
  relayPort: number;
  expiresAt: number;
  permissions: Map<string, Permission>;
  channels: Map<number, ChannelBinding>;
  peerToChannel: Map<string, number>;
  tokens: number;
  tokenAt: number;
};

export type AllocationCreate = {
  key: string;
  user: string;
  password: string;
  client: SocketAddress;
  socket: dgram.Socket;
  relayPort: number;
  lifetimeSec: number;
};

type TableOptions = {
  listenHost: string;
  relayPortRange: { begin: number; end: number };
  maxAllocations: number;
  maxAllocationsPerUser: number;
  bytesPerSecPerAllocation: number;
  now: () => number;
  log?: (line: string) => void;
};

export function peerKey(address: string, port: number): string {
  return `${normalizePeerAddress(address)}#${port}`;
}

export function clientKey(addr: SocketAddress): string {
  return peerKey(addr.address, addr.port);
}

export class AllocationTable {
  private readonly allocations = new Map<string, Allocation>();
  private readonly usedPorts = new Set<number>();

  constructor(private readonly options: TableOptions) {}

  get size(): number {
    return this.allocations.size;
  }

  get(key: string): Allocation | undefined {
    return this.allocations.get(key);
  }

  getByClient(addr: SocketAddress): Allocation | undefined {
    return this.allocations.get(clientKey(addr));
  }

  overQuota(user: string): boolean {
    if (this.allocations.size >= this.options.maxAllocations) return true;
    let n = 0;
    for (const allocation of this.allocations.values()) {
      if (allocation.user === user) n++;
    }
    return n >= this.options.maxAllocationsPerUser;
  }

  counts(): { allocations: number; permissions: number; channels: number } {
    let permissions = 0;
    let channels = 0;
    for (const allocation of this.allocations.values()) {
      permissions += allocation.permissions.size;
      channels += allocation.channels.size;
    }
    return { allocations: this.allocations.size, permissions, channels };
  }

  expireAll(): void {
    const now = this.options.now();
    for (const allocation of [...this.allocations.values()]) {
      expireMaps(allocation, now);
      if (allocation.expiresAt <= now) this.remove(allocation);
    }
  }

  remove(allocation: Allocation): void {
    this.allocations.delete(allocation.key);
    this.usedPorts.delete(allocation.relayPort);
    allocation.socket.removeAllListeners();
    void closeSocket(allocation.socket);
  }

  async closeAll(): Promise<void> {
    const rows = [...this.allocations.values()];
    this.allocations.clear();
    this.usedPorts.clear();
    await Promise.all(
      rows.map((allocation) => {
        allocation.socket.removeAllListeners();
        return closeSocket(allocation.socket);
      })
    );
  }

  async tryBindRelay(): Promise<{ socket: dgram.Socket; port: number } | null> {
    const { begin, end } = this.options.relayPortRange;
    for (let port = begin; port <= end; port++) {
      if (this.usedPorts.has(port)) continue;
      const socket = await this.bindRelayPort(port);
      if (socket) return { socket, port };
    }
    return null;
  }

  private async bindRelayPort(port: number): Promise<dgram.Socket | null> {
    const host = this.options.listenHost;
    const first = await bindUdpResult(host, port);
    if (first.ok) return first.socket;
    if (first.code !== 'EADDRNOTAVAIL' || host === '0.0.0.0') return null;
    this.options.log?.(`turn: bind ${host} failed (EADDRNOTAVAIL), falling back to 0.0.0.0`);
    this.options.listenHost = '0.0.0.0';
    const fallback = await bindUdpResult('0.0.0.0', port);
    return fallback.ok ? fallback.socket : null;
  }

  insert(input: AllocationCreate): Allocation {
    const now = this.options.now();
    const rate = this.options.bytesPerSecPerAllocation;
    const allocation: Allocation = {
      key: input.key,
      user: input.user,
      password: input.password,
      client: input.client,
      socket: input.socket,
      relayPort: input.relayPort,
      expiresAt: now + input.lifetimeSec * 1000,
      permissions: new Map(),
      channels: new Map(),
      peerToChannel: new Map(),
      tokens: rate,
      tokenAt: now,
    };
    this.allocations.set(allocation.key, allocation);
    this.usedPorts.add(allocation.relayPort);
    return allocation;
  }

  installPermission(allocation: Allocation, address: string, port: number, now: number): boolean {
    const key = peerKey(address, port);
    if (
      !allocation.permissions.has(key) &&
      allocation.permissions.size >= MAX_PERMISSIONS_PER_ALLOCATION
    ) {
      return false;
    }
    allocation.permissions.set(key, {
      address,
      port,
      expiresAt: now + PERMISSION_LIFETIME_MS,
    });
    return true;
  }

  bindChannel(
    allocation: Allocation,
    number: number,
    address: string,
    port: number,
    now: number
  ): 'ok' | 'conflict' | 'full' {
    const key = peerKey(address, port);
    const existing = allocation.channels.get(number);
    if (existing && existing.peerKey !== key) return 'conflict';
    const bound = allocation.peerToChannel.get(key);
    if (bound !== undefined && bound !== number) return 'conflict';
    if (
      !allocation.permissions.has(key) &&
      allocation.permissions.size >= MAX_PERMISSIONS_PER_ALLOCATION
    ) {
      return 'full';
    }
    allocation.channels.set(number, {
      number,
      address,
      port,
      peerKey: key,
      expiresAt: now + CHANNEL_LIFETIME_MS,
    });
    allocation.peerToChannel.set(key, number);
    this.installPermission(allocation, address, port, now);
    return 'ok';
  }
}

function expireMaps(allocation: Allocation, now: number): void {
  for (const [key, permission] of allocation.permissions) {
    if (permission.expiresAt <= now) allocation.permissions.delete(key);
  }
  for (const [number, channel] of allocation.channels) {
    if (channel.expiresAt > now) continue;
    allocation.channels.delete(number);
    if (allocation.peerToChannel.get(channel.peerKey) === number) {
      allocation.peerToChannel.delete(channel.peerKey);
    }
  }
}
