import {
  bytesEqual,
  decodeBase64url,
  encodeBase64url,
  hubHostFromUrl,
  signEd25519,
  uplinkAuthMessage,
} from '@tmex/shared/auth';
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
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  type UplinkCtlMessage,
  type UplinkEnrollRedeemed,
  type UplinkKeyLogAck,
  type UplinkKeyLogRecord,
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
export const UPLINK_CONNECT_TIMEOUT_MS = 10_000;
export const UPLINK_AUTH_TIMEOUT_MS = 10_000;
export const UPLINK_STABLE_UPTIME_MS = 30_000;
export const UPLINK_KEY_LOG_ACK_TIMEOUT_MS = 10_000;

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
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
};

function defaultWsFactory(url: string): WebSocketTransportInput {
  return new WebSocket(url);
}

function waitSocketOpen(
  ws: WebSocketTransportInput,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  if (isServerSocketAdapter(ws)) return Promise.resolve();
  const socket = ws as WebSocket;
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      try {
        socket.close(1000, 'aborted');
      } catch {
        // ignore
      }
      finish(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const timer = setTimeout(() => {
      try {
        socket.close(1000, 'connect-timeout');
      } catch {
        // ignore
      }
      finish(new Error('connect-timeout'));
    }, timeoutMs);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('close', (ev) => finish(new Error(ev.reason || 'ws-closed')), {
      once: true,
    });
  });
}

type AuthPhase = 'idle' | 'awaiting-challenge' | 'challenge-accepted';

export class UplinkClient {
  readonly identity: MeshIdentity;
  readonly userId: string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';

  private readonly hubUrl: string;
  private readonly hubHost: string;
  private readonly keyLogApplier: KeyLogApplier;
  private readonly userStore: UserStore;
  private readonly statusProvider: () => UplinkStatus;
  private readonly onNodeListCb?: (list: UplinkNodeList) => void;
  private readonly onRtcSignalCb?: (msg: UplinkRtcSignal) => void;
  private readonly onEnrollRedeemedCb?: (msg: UplinkEnrollRedeemed) => void;
  private readonly onKeyLogForkCb?: (event: KeyLogForkEvent) => void;
  private readonly wsFactory: UplinkWsFactory;
  private readonly scheduler: MeshScheduler;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private heartbeat: { clear: () => void } | null = null;
  private missedPongs = 0;
  private lastStatusJson = '';
  private connectGeneration = 0;
  private authWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private authPhase: AuthPhase = 'idle';
  private catchUpChain: Promise<void> = Promise.resolve();
  private pendingKeyLog: {
    resolve: (records: UplinkKeyLogRecord[]) => void;
  } | null = null;
  private readonly pendingAcks = new Map<string, (ack: UplinkKeyLogAck) => void>();
  private keyLogForked = false;
  private onlineAt = 0;
  private customConnect: ((signal: AbortSignal) => Promise<void>) | null = null;
  lastKeyLogHead: { seq: bigint; hash: Uint8Array } | null = null;

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.hubHost = hubHostFromUrl(opts.hubUrl);
    this.identity = opts.identity;
    this.userId = opts.userId;
    this.keyLogApplier = opts.keyLogApplier;
    this.userStore = opts.userStore;
    this.statusProvider = opts.statusProvider;
    this.onNodeListCb = opts.onNodeList;
    this.onRtcSignalCb = opts.onRtcSignal;
    this.onEnrollRedeemedCb = opts.onEnrollRedeemed;
    this.onKeyLogForkCb = opts.onKeyLogFork;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.pingIntervalMs = opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? UPLINK_CONNECT_TIMEOUT_MS;
    this.authTimeoutMs = opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
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

  start(connectOnce?: (signal: AbortSignal) => Promise<void>): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.customConnect = connectOnce ?? null;
    this.loop = this.runLoop(this.stopAbort.signal);
  }

  /**
   * Bind, authenticate, and mark online against an already-open LinkSession.
   * Resolves once `auth.ok` lands. Used by the WS loop and by in-memory hub,node.
   */
  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    if (!this.stopAbort) {
      this.stopAbort = new AbortController();
    }
    const effective = signal ?? this.stopAbort.signal;
    const generation = ++this.connectGeneration;
    this.link = link;
    this.bindLink(link, generation);
    await this.authenticate(link, effective);
    if (effective.aborted || generation !== this.connectGeneration) {
      throw new Error('aborted');
    }
    this.setState('online');
    this.sendStatus();
    this.startHeartbeat(link, generation);
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
        if (this.customConnect) {
          await this.customConnect(signal);
        } else {
          await this.connectOnce(signal);
        }
        this.onlineAt = this.scheduler.now();
        await this.waitUntilClosed(signal);
        if (signal.aborted) return;
        const uptime = this.scheduler.now() - this.onlineAt;
        this.tearDownLink('disconnected');
        this.setState('offline');
        if (uptime >= UPLINK_STABLE_UPTIME_MS) attempt = 0;
        const delay = backoffDelayMs(attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        attempt += 1;
        try {
          await this.scheduler.sleep(delay, signal);
        } catch {
          return;
        }
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
    await waitSocketOpen(ws, signal, this.connectTimeoutMs);
    const link = new WebSocketLink(ws, { role: 'initiator' });
    await this.connectWithLink(link, signal);
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
      this.authPhase = 'awaiting-challenge';
      const timer = setTimeout(() => finish(new Error('auth-timeout')), this.authTimeoutMs);
      const finish = (err?: Error) => {
        if (!this.authWaiter) return;
        this.authWaiter = null;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (err) {
          this.authPhase = 'idle';
          try {
            link.close(err.message);
          } catch {
            // already closed
          }
          reject(err);
        } else {
          resolve();
        }
      };
      const onAbort = () => finish(new Error('aborted'));
      if (signal.aborted) {
        clearTimeout(timer);
        this.authPhase = 'idle';
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
        this.acceptChallenge(msg.nonce);
        return;
      }
      case 'auth.ok':
        if (this.authPhase === 'challenge-accepted') {
          this.authPhase = 'idle';
          this.authWaiter?.resolve();
        }
        return;
      case 'pong':
        this.missedPongs = 0;
        return;
      case 'ping':
        this.link?.ctl.send(encodeUplinkCtl({ t: 'pong' }));
        return;
      case 'node.list':
        this.ingestNodeList(msg);
        return;
      case 'key.log.res':
        this.pendingKeyLog?.resolve(msg.records);
        this.pendingKeyLog = null;
        return;
      case 'key.log.ack': {
        const waiter = this.pendingAcks.get(msg.id);
        this.pendingAcks.delete(msg.id);
        waiter?.(msg);
        return;
      }
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

  private acceptChallenge(nonceB64: string): void {
    if (this.authPhase !== 'awaiting-challenge' || !this.link) {
      return;
    }
    let nonce: Uint8Array;
    try {
      nonce = decodeBase64url(nonceB64);
    } catch {
      this.authWaiter?.reject(new Error('bad-nonce'));
      return;
    }
    if (nonce.byteLength !== 32) {
      this.authWaiter?.reject(new Error('bad-nonce'));
      return;
    }
    this.authPhase = 'challenge-accepted';
    const sig = signEd25519(this.identity.edSecretKey, uplinkAuthMessage(nonce, this.hubHost));
    this.link.ctl.send(
      encodeUplinkCtl({
        t: 'auth.response',
        node_id: this.identity.nodeId,
        sig: encodeBase64url(sig),
      })
    );
  }

  private ingestNodeList(list: UplinkNodeList): void {
    const now = this.scheduler.now();
    this.lastKeyLogHead = list.key_log_head;
    if (list.hub) {
      this.userStore.upsertHubMeta({
        nodeId: list.hub.nodeId,
        publicUrl: list.hub.publicUrl,
        now,
        listVersion: list.version,
      });
    }
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
    this.catchUpChain = this.catchUpChain
      .then(() => this.catchUpFromList(list))
      .catch(() => undefined);
  }

  private async catchUpFromList(list: UplinkNodeList): Promise<void> {
    if (this.keyLogForked) return;
    const target = list.key_log_head;
    let local = await this.keyLogApplier.head(this.userId);
    if (local.seq === target.seq) {
      if (!bytesEqual(local.hash, target.hash)) {
        this.failFork(local, target);
        return;
      }
      this.onNodeListCb?.(list);
      return;
    }
    if (local.seq > target.seq) {
      await this.pushMissingToHub(target.seq);
      this.onNodeListCb?.(list);
      return;
    }
    while (!this.keyLogForked && local.seq < target.seq) {
      const before = local;
      const records = await this.requestKeyLog(local.seq + 1n);
      if (this.keyLogForked) return;
      if (records.length === 0) break;
      const sorted = [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      if (sorted[0] && sorted[0].seq !== before.seq + 1n) break;
      const result = await this.keyLogApplier.applyMany(
        this.userId,
        sorted.map((row) => ({ bytes: row.bytes, sig: row.sig }))
      );
      if (result.error) break;
      local = await this.keyLogApplier.head(this.userId);
      if (local.seq === before.seq) break;
    }
    if (this.keyLogForked) return;
    if (local.seq === target.seq && !bytesEqual(local.hash, target.hash)) {
      this.failFork(local, target);
      return;
    }
    this.onNodeListCb?.(list);
  }

  async queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    return this.lastKeyLogHead;
  }

  async queryKeyLogAt(
    seq: bigint,
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null> {
    if (!this.link || this.state !== 'online' || this.pendingKeyLog) return null;
    const records = await new Promise<UplinkKeyLogRecord[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingKeyLog) {
          this.pendingKeyLog = null;
          resolve([]);
        }
      }, timeoutMs);
      this.pendingKeyLog = {
        resolve: (rows) => {
          clearTimeout(timer);
          resolve(rows);
        },
      };
      try {
        this.link?.ctl.send(encodeUplinkCtl({ t: 'key.log.req', from_seq: seq }));
      } catch {
        clearTimeout(timer);
        this.pendingKeyLog = null;
        resolve([]);
      }
    });
    const found = records.find((row) => row.seq === seq);
    return found ? { bytes: found.bytes, sig: found.sig } : null;
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<UplinkKeyLogAck> {
    if (!this.link || this.state !== 'online') {
      return { t: 'key.log.ack', id: '', ok: false, error: 'offline' };
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pendingAcks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      try {
        this.link?.ctl.send(
          encodeUplinkCtl({
            t: 'key.log.append',
            bytes: record.bytes,
            sig: record.sig,
            id,
          })
        );
      } catch {
        this.pendingAcks.delete(id);
        clearTimeout(timer);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'offline' });
      }
    });
  }

  private async pushMissingToHub(hubSeq: bigint): Promise<void> {
    const listed = await this.keyLogApplier.list?.(this.userId, hubSeq + 1n);
    if (!listed || listed.length === 0) return;
    const sorted = [...listed].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (const row of sorted) {
      if (row.seq <= hubSeq) continue;
      const ack = await this.appendAndAck({ bytes: row.bytes, sig: row.sig });
      if (!ack.ok) return;
    }
  }

  private requestKeyLog(fromSeq: bigint): Promise<UplinkKeyLogRecord[]> {
    if (!this.link || this.pendingKeyLog) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.pendingKeyLog = { resolve };
      this.link?.ctl.send(encodeUplinkCtl({ t: 'key.log.req', from_seq: fromSeq }));
    });
  }

  private failFork(
    local: { seq: bigint; hash: Uint8Array },
    remote: { seq: bigint; hash: Uint8Array }
  ): void {
    this.keyLogForked = true;
    this.onKeyLogForkCb?.({ userId: this.userId, local, remote });
    this.tearDownLink('key_log_fork');
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
    const pending = this.pendingKeyLog;
    this.pendingKeyLog = null;
    pending?.resolve([]);
    const acks = [...this.pendingAcks.entries()];
    this.pendingAcks.clear();
    for (const [id, waiter] of acks) {
      waiter({ t: 'key.log.ack', id, ok: false, error: 'offline' });
    }
    const link = this.link;
    this.link = null;
    this.authPhase = 'idle';
    this.connectGeneration += 1;
    if (this.authWaiter) {
      this.authWaiter.reject(new Error(reason));
    }
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
