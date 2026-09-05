import type { LinkStream } from '@tmex/shared/link';
import type { InboundRelayHandler, MeshScheduler, PooledUplink } from './types';

export const UPLINK_RELAY_DRAIN_RECHECK_MS = 3_000;
export const UPLINK_RELAY_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

export type UplinkRelayDrainReason = 'reconfigure' | 'retire' | 'nearest' | 'switch-back';

type DrainAwareUplink = PooledUplink & {
  readonly inFlightRelayStreams?: number;
  beginRelayDrain?: () => void;
};

export class UplinkRelayDrain {
  private readonly streamsByClient = new WeakMap<PooledUplink, Set<LinkStream>>();
  private readonly retiringClients = new Set<PooledUplink>();
  private readonly retiringTasks = new Set<Promise<void>>();
  private handler: InboundRelayHandler | null = null;

  constructor(
    private readonly opts: {
      scheduler: MeshScheduler;
      recheckMs?: number;
      timeoutMs?: number;
      log: (line: string) => void;
    }
  ) {}

  setHandler(handler: InboundRelayHandler | null): void {
    this.handler = handler;
  }

  bind(client: PooledUplink, isLive: () => boolean): void {
    client.setOnRelayStream((stream, fromNodeId) => {
      if (!isLive()) {
        stream.reset('stale');
        return;
      }
      const handler = this.handler;
      if (!handler) {
        stream.reset('relay-unhandled');
        return;
      }
      handler(this.track(client, stream), fromNodeId);
    });
  }

  async open(client: PooledUplink, toNodeId: string, isLive: () => boolean): Promise<LinkStream> {
    const stream = await client.openRelay(toNodeId);
    if (!isLive() || this.retiringClients.has(client)) {
      stream.reset('uplink-retiring');
      throw new Error('uplink is not online');
    }
    return this.track(client, stream);
  }

  track(client: PooledUplink, stream: LinkStream): LinkStream {
    let streams = this.streamsByClient.get(client);
    if (!streams) {
      streams = new Set();
      this.streamsByClient.set(client, streams);
    }
    if (streams.has(stream)) return stream;
    streams.add(stream);
    const remove = () => streams?.delete(stream);
    void stream.closed.then(remove, remove);
    return stream;
  }

  total(live: PooledUplink | null): number {
    let total = 0;
    for (const client of this.clientsWith(live)) total += this.count(client);
    return total;
  }

  waitForAll(liveOf: () => PooledUplink | null, signal?: AbortSignal): Promise<void> {
    return this.waitFor(() => this.clientsWith(liveOf()), 'reconfigure', signal);
  }

  waitForClient(
    client: PooledUplink,
    reason: UplinkRelayDrainReason,
    signal?: AbortSignal
  ): Promise<void> {
    return this.waitFor(() => new Set([client]), reason, signal);
  }

  retire(client: PooledUplink, signal?: AbortSignal): void {
    if (this.retiringClients.has(client)) return;
    this.retiringClients.add(client);
    this.begin(client);
    const task = this.stopAfterDrain(client, signal);
    this.retiringTasks.add(task);
    void task.finally(() => {
      this.retiringTasks.delete(task);
      this.retiringClients.delete(client);
    });
  }

  async waitForRetiring(): Promise<void> {
    await Promise.all([...this.retiringTasks]);
  }

  private begin(client: PooledUplink): void {
    (client as DrainAwareUplink).beginRelayDrain?.();
    client.setOnRelayStream((stream) => stream.reset('uplink-retiring'));
  }

  private async stopAfterDrain(client: PooledUplink, signal?: AbortSignal): Promise<void> {
    await this.waitForClient(client, 'retire', signal);
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
  }

  private clientsWith(live: PooledUplink | null): ReadonlySet<PooledUplink> {
    const clients = new Set(this.retiringClients);
    if (live) clients.add(live);
    return clients;
  }

  private count(client: PooledUplink): number {
    const tracked = this.streamsByClient.get(client)?.size ?? 0;
    return Math.max(tracked, (client as DrainAwareUplink).inFlightRelayStreams ?? 0);
  }

  private closures(clients: ReadonlySet<PooledUplink>): Promise<unknown>[] {
    const closed: Promise<unknown>[] = [];
    for (const client of clients) {
      for (const stream of this.streamsByClient.get(client) ?? []) closed.push(stream.closed);
    }
    return closed;
  }

  private activeClients(clients: ReadonlySet<PooledUplink>): ReadonlySet<PooledUplink> {
    return new Set(
      [...clients].filter(
        (client) => client.state === 'online' && client.link !== null && this.count(client) > 0
      )
    );
  }

  private async waitFor(
    clientsOf: () => ReadonlySet<PooledUplink>,
    reason: UplinkRelayDrainReason,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = this.opts.scheduler.now();
    const timeoutMs = this.opts.timeoutMs ?? UPLINK_RELAY_DRAIN_TIMEOUT_MS;
    const recheckMs = this.opts.recheckMs ?? UPLINK_RELAY_DRAIN_RECHECK_MS;
    while (!signal?.aborted) {
      const clients = this.activeClients(clientsOf());
      if (clients.size === 0) return;
      const elapsed = this.opts.scheduler.now() - startedAt;
      if (elapsed >= timeoutMs) {
        const streams = [...clients].reduce((total, client) => total + this.count(client), 0);
        this.opts.log(`[uplink] relay drain timeout reason=${reason} streams=${streams}`);
        return;
      }
      const delay = Math.min(recheckMs, timeoutMs - elapsed);
      const closures = this.closures(clients);
      try {
        const sleep = this.opts.scheduler.sleep(delay, signal);
        if (closures.length > 0) await Promise.race([Promise.all(closures), sleep]);
        else await sleep;
      } catch {
        return;
      }
    }
  }
}
