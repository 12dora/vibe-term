import type { LinkStream } from '@vibeterm/shared/link';
import type { InboundRelayHandler, MeshScheduler, PooledUplink } from './types';

export const UPLINK_RELAY_DRAIN_RECHECK_MS = 3_000;
/** 新上行在线后，旧上行最多再留这么久，等它上面的用户流结束。 */
export const UPLINK_RELAY_DRAIN_TIMEOUT_MS = 30_000;

const streamsByOwner = new WeakMap<object, Set<LinkStream>>();
const ownersByUrl = new Map<string, object[]>();
const streamsByUrl = new Map<string, Set<LinkStream>>();
const streamClient = new WeakMap<object, object>();
const sessionClient = new WeakMap<object, object>();

/** 记一条骑在某条中继 peer session 里的用户流。按客户端实例计，不按 URL 合并。 */
export function noteRelayCarriedStream(owner: object | string, stream: LinkStream): void {
  const target = typeof owner === 'string' ? noteTargetForUrl(owner) : owner;
  addCarried(target, stream);
}

export function relayCarriedStreamCount(owner: object | string): number {
  if (typeof owner === 'string') return countForUrl(owner);
  return streamsByOwner.get(owner)?.size ?? 0;
}

export function bindRelayDrainOwner(owner: object, url: string): void {
  let list = ownersByUrl.get(url);
  if (!list) {
    list = [];
    ownersByUrl.set(url, list);
  }
  if (!list.includes(owner)) list.push(owner);
}

export function unbindRelayDrainOwner(owner: object, url: string): void {
  const list = ownersByUrl.get(url);
  if (!list) return;
  const idx = list.lastIndexOf(owner);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) ownersByUrl.delete(url);
}

export function bindRelayStreamClient<T extends object>(stream: T, client: object): T {
  streamClient.set(stream, client);
  return stream;
}

export function adoptRelayStreamOwner(stream: object, session: object): void {
  const client = streamClient.get(stream);
  if (client) sessionClient.set(session, client);
}

export function relaySessionOwner(session: object): object | undefined {
  return sessionClient.get(session);
}

export function noteRelaySessionStream(session: object, stream: LinkStream): void {
  const owner = sessionClient.get(session);
  if (owner) noteRelayCarriedStream(owner, stream);
}

export function noteLiveRelayStream(
  live: { session: object; transport: string; viaRelay?: string | null },
  stream: LinkStream
): void {
  if (live.transport !== 'relay') return;
  const owner = relaySessionOwner(live.session) ?? live.viaRelay;
  if (owner) noteRelayCarriedStream(owner, stream);
}

export function resetRelayCarriedStreamsForTest(): void {
  ownersByUrl.clear();
  streamsByUrl.clear();
}

function noteTargetForUrl(url: string): object | string {
  return latestOwner(url) ?? url;
}

function addCarried(target: object | string, stream: LinkStream): void {
  const set = typeof target === 'string' ? ensureUrl(target) : ensureStreams(target);
  if (set.has(stream)) return;
  set.add(stream);
  const remove = () => {
    set.delete(stream);
    if (set.size === 0 && typeof target === 'string') streamsByUrl.delete(target);
  };
  void stream.closed.then(remove, remove);
}

function ensureStreams(owner: object): Set<LinkStream> {
  let set = streamsByOwner.get(owner);
  if (!set) {
    set = new Set();
    streamsByOwner.set(owner, set);
  }
  return set;
}

function ensureUrl(url: string): Set<LinkStream> {
  let set = streamsByUrl.get(url);
  if (!set) {
    set = new Set();
    streamsByUrl.set(url, set);
  }
  return set;
}

function countForUrl(url: string): number {
  const owner = latestOwner(url);
  if (owner) return streamsByOwner.get(owner)?.size ?? 0;
  return streamsByUrl.get(url)?.size ?? 0;
}

function latestOwner(url: string): object | null {
  const list = ownersByUrl.get(url);
  if (!list || list.length === 0) return null;
  return list[list.length - 1] ?? null;
}

function carriedCountFor(client: PooledUplink): number {
  const own = streamsByOwner.get(client)?.size ?? 0;
  const list = ownersByUrl.get(client.uplinkUrl);
  if (list && list.length > 0) return own;
  return own + (streamsByUrl.get(client.uplinkUrl)?.size ?? 0);
}

function carriedStreamsFor(client: PooledUplink): Iterable<LinkStream> {
  const own = streamsByOwner.get(client);
  const list = ownersByUrl.get(client.uplinkUrl);
  if (list && list.length > 0) return own ?? [];
  const bucket = streamsByUrl.get(client.uplinkUrl);
  if (own && bucket) return [...own, ...bucket];
  return own ?? bucket ?? [];
}

export type UplinkRelayDrainReason =
  | 'reconfigure'
  | 'retire'
  | 'nearest'
  | 'switch-back'
  | 'auto-select';

type DrainAwareUplink = PooledUplink & {
  beginRelayDrain?: () => void;
};

export class UplinkRelayDrain {
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
    bindRelayDrainOwner(client, client.uplinkUrl);
    client.setOnRelayStream((stream, fromNodeId, viaRelay) => {
      bindRelayStreamClient(stream, client);
      if (!this.acceptInbound(client, isLive)) {
        stream.reset('stale');
        return;
      }
      const handler = this.handler;
      if (!handler) {
        stream.reset('relay-unhandled');
        return;
      }
      handler(this.track(client, stream), fromNodeId, viaRelay ?? client.uplinkUrl);
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
    void client.uplinkUrl;
    return stream;
  }

  total(live: PooledUplink | null): number {
    let total = 0;
    for (const client of this.clientsWith(live)) total += this.count(client);
    return total;
  }

  inFlight(client: PooledUplink): number {
    return this.count(client);
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

  retire(client: PooledUplink, signal?: AbortSignal, onDone?: () => void): void {
    if (this.retiringClients.has(client)) return;
    bindRelayDrainOwner(client, client.uplinkUrl);
    this.retiringClients.add(client);
    this.begin(client);
    const task = this.stopAfterDrain(client, signal);
    this.retiringTasks.add(task);
    void task.finally(() => {
      this.retiringTasks.delete(task);
      this.retiringClients.delete(client);
      unbindRelayDrainOwner(client, client.uplinkUrl);
      onDone?.();
    });
  }

  async waitForRetiring(): Promise<void> {
    await Promise.all([...this.retiringTasks]);
  }

  private begin(client: PooledUplink): void {
    (client as DrainAwareUplink).beginRelayDrain?.();
  }

  /** 已交给 secondary 的连接不走这里。排空中的上行不再接新入站，避免 30s 后被掐。 */
  private acceptInbound(_client: PooledUplink, isLive: () => boolean): boolean {
    return isLive();
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
    return carriedCountFor(client);
  }

  private closures(clients: ReadonlySet<PooledUplink>): Promise<unknown>[] {
    const closed: Promise<unknown>[] = [];
    for (const client of clients) {
      for (const stream of carriedStreamsFor(client)) closed.push(stream.closed);
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
