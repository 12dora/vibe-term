import { decodeBase64url, encodeBase64url, signEd25519 } from '@tmex/shared/auth';
import {
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  WebSocketLink,
  type WebSocketTransportInput,
} from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler, jsonStable } from './ctl';
import { parseOpenPayload } from './peer-protocol';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  type UplinkCtlMessage,
  type UplinkEnrollRedeemed,
  type UplinkNodeList,
  type UplinkRtcSignal,
  decodeUplinkCtl,
  encodeUplinkCtl,
  uplinkWsUrl,
} from './uplink-protocol';

export const UPLINK_PING_INTERVAL_MS = 15_000;
export const UPLINK_MISSED_PONG_LIMIT = 3;
export const UPLINK_BACKOFF_MIN_MS = 1_000;
export const UPLINK_BACKOFF_MAX_MS = 60_000;

export type UplinkWsFactory = (
  url: string
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

export type UplinkClientOptions = {
  hubUrl: string;
  identity: MeshIdentity;
  userId: string;
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus;
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
};

function defaultWsFactory(url: string): WebSocketTransportInput {
  return new WebSocket(url);
}

function waitSocketOpen(ws: WebSocketTransportInput, signal: AbortSignal): Promise<void> {
  if (isServerSocketAdapter(ws)) return Promise.resolve();
  const socket = ws as WebSocket;
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener(
      'open',
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'close',
      (ev) => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(ev.reason || 'ws-closed'));
      },
      { once: true }
    );
  });
}

export class UplinkClient {
  readonly identity: MeshIdentity;
  readonly userId: string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';

  private readonly hubUrl: string;
  private readonly keyLogApplier: KeyLogApplier;
  private readonly userStore: UserStore;
  private readonly statusProvider: () => UplinkStatus;
  private readonly onNodeListCb?: (list: UplinkNodeList) => void;
  private readonly onRtcSignalCb?: (msg: UplinkRtcSignal) => void;
  private readonly onEnrollRedeemedCb?: (msg: UplinkEnrollRedeemed) => void;
  private readonly wsFactory: UplinkWsFactory;
  private readonly scheduler: MeshScheduler;
  private readonly pingIntervalMs: number;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private heartbeat: { clear: () => void } | null = null;
  private missedPongs = 0;
  private lastStatusJson = '';
  private connectGeneration = 0;
  private authWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.identity = opts.identity;
    this.userId = opts.userId;
    this.keyLogApplier = opts.keyLogApplier;
    this.userStore = opts.userStore;
    this.statusProvider = opts.statusProvider;
    this.onNodeListCb = opts.onNodeList;
    this.onRtcSignalCb = opts.onRtcSignal;
    this.onEnrollRedeemedCb = opts.onEnrollRedeemed;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.pingIntervalMs = opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS;
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
  }

  start(): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.loop = this.runLoop(this.stopAbort.signal);
  }

  async stop(): Promise<void> {
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopHeartbeat();
    this.tearDownLink('stopped');
    this.setState('offline');
    const loop = this.loop;
    this.loop = null;
    if (loop) {
      try {
        await loop;
      } catch {
        // cancelled
      }
    }
  }

  sendCtl(msg: UplinkCtlMessage): void {
    const link = this.link;
    if (!link || this.state !== 'online') {
      throw new Error('uplink is not online');
    }
    link.ctl.send(encodeUplinkCtl(msg));
  }

  sendStatus(): void {
    if (this.state !== 'online' || !this.link) return;
    const status = this.statusProvider();
    this.lastStatusJson = jsonStable(status);
    this.link.ctl.send(
      encodeUplinkCtl({
        t: 'node.status',
        version: status.version,
        tmux: status.tmux,
        direct_capable: status.direct_capable,
        inventory: status.inventory,
        endpoints: status.endpoints,
      })
    );
  }

  async openRelay(toNodeId: string): Promise<LinkStream> {
    const link = this.link;
    if (!link || this.state !== 'online') {
      throw new Error('uplink is not online');
    }
    return link.openStream(new TextEncoder().encode(JSON.stringify({ to: toNodeId })));
  }

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        // listener errors must not break the client
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      this.setState('connecting');
      try {
        await this.connectOnce(signal);
        attempt = 0;
        await this.waitUntilClosed(signal);
      } catch {
        this.tearDownLink('connect-failed');
        this.setState('offline');
        if (signal.aborted) return;
        const delay = backoffDelayMs(attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        attempt += 1;
        try {
          await this.scheduler.sleep(delay, signal);
        } catch {
          return;
        }
      }
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const url = uplinkWsUrl(this.hubUrl);
    const ws = await this.wsFactory(url);
    await waitSocketOpen(ws, signal);
    const generation = ++this.connectGeneration;
    const link = new WebSocketLink(ws, { role: 'initiator' });
    this.link = link;
    this.bindLink(link, generation);
    await this.authenticate(link, signal);
    if (signal.aborted || generation !== this.connectGeneration) {
      throw new Error('aborted');
    }
    this.setState('online');
    this.sendStatus();
    this.startHeartbeat(link, generation);
  }

  private bindLink(link: LinkSession, generation: number): void {
    link.ctl.onMessage((bytes) => {
      if (generation !== this.connectGeneration) return;
      try {
        this.handleCtl(decodeUplinkCtl(bytes));
      } catch {
        // ignore malformed ctl
      }
    });
    link.onStream((stream) => {
      if (generation !== this.connectGeneration) return;
      const open = parseOpenPayload(stream.openPayload);
      const to = typeof open?.to === 'string' ? open.to : '';
      const from = typeof open?.from === 'string' ? open.from : '';
      if (to === this.identity.nodeId && from) {
        this.relayHandler?.(stream, from);
      }
    });
  }

  private authenticate(link: LinkSession, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        if (!this.authWaiter) return;
        this.authWaiter = null;
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish(new Error('aborted'));
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.authWaiter = {
        resolve: () => finish(),
        reject: (err) => finish(err),
      };
      void link.closed.then((info) => {
        if (this.authWaiter) {
          finish(new Error(info.reason || 'link-closed'));
        }
      });
    });
  }

  private handleCtl(msg: UplinkCtlMessage): void {
    switch (msg.t) {
      case 'auth.challenge': {
        if (this.link) {
          const nonce = decodeBase64url(msg.nonce);
          const sig = signEd25519(this.identity.edSecretKey, nonce);
          this.link.ctl.send(
            encodeUplinkCtl({
              t: 'auth.response',
              node_id: this.identity.nodeId,
              sig: encodeBase64url(sig),
            })
          );
        }
        return;
      }
      case 'auth.ok':
        this.authWaiter?.resolve();
        return;
      case 'pong':
        this.missedPongs = 0;
        return;
      case 'ping':
        this.link?.ctl.send(encodeUplinkCtl({ t: 'pong' }));
        return;
      case 'node.list':
        void this.applyNodeList(msg);
        return;
      case 'key.log.res':
        void this.keyLogApplier.applyMany(this.userId, msg.records);
        return;
      case 'rtc.signal':
        this.onRtcSignalCb?.(msg);
        return;
      case 'enroll.redeemed':
        this.onEnrollRedeemedCb?.(msg);
        return;
      default:
        return;
    }
  }

  private async applyNodeList(list: UplinkNodeList): Promise<void> {
    const now = this.scheduler.now();
    for (const node of list.nodes) {
      if (node.id === this.identity.nodeId) continue;
      this.userStore.upsertPeer({
        nodeId: node.id,
        name: node.name,
        endpointsJson: jsonText(node.endpoints),
        inventoryJson: jsonText(node.inventory),
        directCapable: node.direct_capable,
        lastSeenAt: now,
        listVersion: list.version,
      });
    }
    this.onNodeListCb?.(list);
    try {
      const head = await this.keyLogApplier.head(this.userId);
      if (list.key_log_head.seq > head.seq) {
        this.link?.ctl.send(encodeUplinkCtl({ t: 'key.log.req', from_seq: head.seq + 1n }));
      }
    } catch {
      // applier unavailable
    }
  }

  private startHeartbeat(link: LinkSession, generation: number): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeat = this.scheduler.interval(() => {
      if (generation !== this.connectGeneration || this.state !== 'online') return;
      if (this.missedPongs >= UPLINK_MISSED_PONG_LIMIT) {
        this.tearDownLink('missed-pong');
        return;
      }
      this.missedPongs += 1;
      try {
        link.ctl.send(encodeUplinkCtl({ t: 'ping' }));
      } catch {
        this.tearDownLink('ping-failed');
      }
      const status = this.statusProvider();
      const encoded = jsonStable(status);
      if (encoded !== this.lastStatusJson) {
        this.sendStatus();
      }
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    this.heartbeat?.clear();
    this.heartbeat = null;
    this.missedPongs = 0;
  }

  private tearDownLink(reason: string): void {
    this.stopHeartbeat();
    const link = this.link;
    this.link = null;
    this.connectGeneration += 1;
    if (this.state === 'online') {
      this.setState('connecting');
    }
    try {
      link?.close(reason);
    } catch {
      // already closed
    }
  }

  private waitUntilClosed(signal: AbortSignal): Promise<void> {
    const link = this.link;
    if (!link) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => resolve();
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void link.closed.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? null);
}
