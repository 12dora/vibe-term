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
  UPLINK_CTL_TYPES,
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
export const UPLINK_KEY_LOG_RETRY_LIMIT = 3;
export const UPLINK_CTL_WARN_INTERVAL_MS = 5_000;

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
  userId: string | (() => string);
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
  keyLogTimeoutMs?: number;
  keyLogRetryLimit?: number;
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
  private readonly userIdOf: () => string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';

  get userId(): string {
    return this.userIdOf();
  }

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
  private readonly keyLogTimeoutMs: number;
  private readonly keyLogRetryLimit: number;
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
    id: string;
    resolve: (records: UplinkKeyLogRecord[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private authenticatedGeneration = 0;
  private listEpoch = 0;
  private listVersionWatermark = Number.NEGATIVE_INFINITY;
  private latestList: UplinkNodeList | null = null;
  private lastCtlWarnAt = 0;
  private keyLogResMissingIdWarned = false;
  private readonly pendingAcks = new Map<string, (ack: UplinkKeyLogAck) => void>();
  private keyLogForked = false;
  private onlineAt = 0;
  private customConnect: ((signal: AbortSignal) => Promise<void>) | null = null;
  lastKeyLogHead: { seq: bigint; hash: Uint8Array } | null = null;

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.hubHost = hubHostFromUrl(opts.hubUrl);
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
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
    this.keyLogTimeoutMs = opts.keyLogTimeoutMs ?? UPLINK_KEY_LOG_ACK_TIMEOUT_MS;
    this.keyLogRetryLimit = opts.keyLogRetryLimit ?? UPLINK_KEY_LOG_RETRY_LIMIT;
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
    this.resetConnectionState();
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
    if (!link || this.state !== 'online' || !this.isAuthenticated()) {
      throw new Error('uplink is not online');
    }
    link.ctl.send(encodeUplinkCtl(msg));
  }

  sendStatus(): void {
    if (this.state !== 'online' || !this.link || !this.isAuthenticated()) return;
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

  sendStatusIfChanged(): boolean {
    if (this.state !== 'online' || !this.link) return false;
    const encoded = jsonStable(this.statusProvider());
    if (encoded === this.lastStatusJson) return false;
    this.sendStatus();
    return true;
  }

  async openRelay(toNodeId: string): Promise<LinkStream> {
    const link = this.link;
    if (!link || this.state !== 'online' || !this.isAuthenticated()) {
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
      let type = '';
      try {
        const msg = decodeUplinkCtl(bytes);
        type = msg.t;
        try {
          this.handleCtl(msg, generation);
        } catch (err) {
          this.warnCtl('handler', type, bytes.byteLength, err);
        }
      } catch (err) {
        type = ctlTypeHint(bytes);
        this.warnCtl('decode', type, bytes.byteLength, err);
      }
    });
    link.onStream((stream) => {
      if (generation !== this.connectGeneration) return;
      if (this.authenticatedGeneration !== generation) {
        stream.reset('unauthenticated');
        return;
      }
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

  private isAuthenticated(): boolean {
    return (
      this.authenticatedGeneration === this.connectGeneration && this.authenticatedGeneration > 0
    );
  }

  private handleCtl(msg: UplinkCtlMessage, generation: number): void {
    switch (msg.t) {
      case 'auth.challenge': {
        this.acceptChallenge(msg.nonce);
        return;
      }
      case 'auth.ok':
        if (this.authPhase === 'challenge-accepted' && generation === this.connectGeneration) {
          this.authPhase = 'idle';
          this.authenticatedGeneration = generation;
          this.authWaiter?.resolve();
        }
        return;
      case 'pong':
        this.missedPongs = 0;
        return;
      case 'ping':
        this.link?.ctl.send(encodeUplinkCtl({ t: 'pong' }));
        return;
      default:
        break;
    }
    if (this.authenticatedGeneration !== generation) return;
    switch (msg.t) {
      case 'node.list':
        this.ingestNodeList(msg);
        return;
      case 'key.log.res': {
        const pending = this.pendingKeyLog;
        if (!pending) return;
        if (msg.id !== pending.id) {
          if (!msg.id && !this.keyLogResMissingIdWarned) {
            this.keyLogResMissingIdWarned = true;
            console.warn('[uplink] key.log.res dropped: missing id');
          }
          return;
        }
        this.pendingKeyLog = null;
        pending.resolve(msg.records);
        return;
      }
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
    if (list.version < this.listVersionWatermark) return;
    this.listVersionWatermark = list.version;
    this.lastKeyLogHead = list.key_log_head;
    this.latestList = list;
    const generation = this.connectGeneration;
    const epoch = ++this.listEpoch;
    if (list.hub) {
      this.userStore.upsertHubMeta({
        nodeId: list.hub.nodeId,
        publicUrl: list.hub.publicUrl,
        now: this.scheduler.now(),
        listVersion: list.version,
      });
    }
    this.persistAdmittedPeers(list);
    this.catchUpChain = this.catchUpChain
      .then(() => {
        if (generation !== this.connectGeneration) return;
        return this.catchUpFromList(list, epoch, generation);
      })
      .catch((err) => {
        this.warnCtl('handler', 'key-log.catch-up', 0, err);
      });
  }

  private persistAdmittedPeers(list: UplinkNodeList): void {
    const now = this.scheduler.now();
    for (const node of list.nodes) {
      if (node.id === this.identity.nodeId) continue;
      const cert = this.userStore.getCert(node.id);
      if (!cert || cert.userId !== this.userId || cert.revokedLogSeq != null) continue;
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
  }

  private finishNodeList(epoch: number, generation: number): void {
    if (epoch !== this.listEpoch || generation !== this.connectGeneration) return;
    const list = this.latestList;
    if (!list) return;
    this.persistAdmittedPeers(list);
    this.onNodeListCb?.(list);
  }

  private catchUpAlive(generation: number): boolean {
    return generation === this.connectGeneration && this.isAuthenticated() && !this.keyLogForked;
  }

  private catchUpCurrent(epoch: number, generation: number): boolean {
    return this.catchUpAlive(generation) && epoch === this.listEpoch;
  }

  private async catchUpFromList(
    list: UplinkNodeList,
    epoch: number,
    generation: number
  ): Promise<void> {
    if (!this.catchUpCurrent(epoch, generation)) return;
    if (!this.userId) {
      console.warn('[uplink] key-log catch-up skipped: empty userId');
      this.finishNodeList(epoch, generation);
      return;
    }
    const target = list.key_log_head;
    let retries = 0;
    let local: { seq: bigint; hash: Uint8Array } | null = null;
    while (this.catchUpCurrent(epoch, generation)) {
      try {
        local = await this.keyLogApplier.head(this.userId);
        break;
      } catch (err) {
        if (!this.catchUpCurrent(epoch, generation)) return;
        retries += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[uplink] key-log head failed err=${message} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-head-failed'))) return;
      }
    }
    if (!local || !this.catchUpCurrent(epoch, generation)) return;
    if (local.seq !== target.seq) {
      console.warn(
        `[uplink] key-log catch-up start local=${local.seq.toString()} target=${target.seq.toString()}`
      );
    }
    if (local.seq === target.seq) {
      if (!bytesEqual(local.hash, target.hash)) {
        this.failFork(local, target);
        return;
      }
      this.finishNodeList(epoch, generation);
      return;
    }
    if (local.seq > target.seq) {
      retries = 0;
      while (this.catchUpCurrent(epoch, generation)) {
        let pushed = false;
        try {
          pushed = await this.pushMissingToHub(target.seq);
        } catch (err) {
          if (!this.catchUpCurrent(epoch, generation)) return;
          retries += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[uplink] key-log list/push failed err=${message} retry=${retries}`);
          if (!(await this.retryOrTearDown(retries, 'key-log-push-failed'))) return;
          continue;
        }
        if (!this.catchUpCurrent(epoch, generation)) return;
        if (pushed) {
          this.finishNodeList(epoch, generation);
          return;
        }
        retries += 1;
        if (!(await this.retryOrTearDown(retries, 'key-log-push-failed'))) return;
      }
      return;
    }
    retries = 0;
    while (this.catchUpCurrent(epoch, generation) && local.seq < target.seq) {
      const before = local;
      let records: UplinkKeyLogRecord[];
      try {
        records = await this.requestKeyLog(before.seq + 1n);
      } catch (err) {
        if (!this.catchUpAlive(generation)) return;
        if (epoch !== this.listEpoch) return;
        retries += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[uplink] key-log catch-up request failed local=${before.seq.toString()} err=${message} retry=${retries}`
        );
        if (!(await this.retryOrTearDown(retries, 'key-log-catch-up-failed'))) return;
        continue;
      }
      if (!this.catchUpAlive(generation)) return;
      if (records.length === 0) {
        if (epoch !== this.listEpoch) return;
        retries += 1;
        console.warn(
          `[uplink] key-log catch-up empty res local=${before.seq.toString()} target=${target.seq.toString()} retry=${retries}`
        );
        if (!(await this.retryOrTearDown(retries, 'key-log-catch-up-failed'))) return;
        continue;
      }
      const sorted = [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      if (sorted[0] && sorted[0].seq !== before.seq + 1n) {
        console.warn(
          `[uplink] key-log catch-up seq gap want=${(before.seq + 1n).toString()} got=${sorted[0].seq.toString()}`
        );
        this.tearDownLink('key-log-seq-gap');
        return;
      }
      let result: { applied: number; error?: string };
      try {
        result = await this.keyLogApplier.applyMany(
          this.userId,
          sorted.map((row) => ({ bytes: row.bytes, sig: row.sig }))
        );
      } catch (err) {
        if (!this.catchUpAlive(generation)) return;
        if (epoch !== this.listEpoch) return;
        retries += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[uplink] key-log applyMany threw err=${message} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-apply-failed'))) return;
        continue;
      }
      try {
        local = await this.keyLogApplier.head(this.userId);
      } catch (err) {
        if (!this.catchUpAlive(generation)) return;
        if (epoch !== this.listEpoch) return;
        retries += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[uplink] key-log head failed err=${message} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-head-failed'))) return;
        continue;
      }
      if (!this.catchUpAlive(generation)) return;
      if (result.error === 'fork') {
        this.failFork(local, target);
        return;
      }
      if (epoch !== this.listEpoch) return;
      if (result.error) {
        console.warn(
          `[uplink] key-log applyMany rejected: ${result.error} applied=${result.applied}`
        );
        retries += 1;
        if (!(await this.retryOrTearDown(retries, 'key-log-apply-failed'))) return;
        continue;
      }
      if (local.seq === before.seq) {
        console.warn('[uplink] key-log catch-up stalled: head did not advance');
        retries += 1;
        if (!(await this.retryOrTearDown(retries, 'key-log-stalled'))) return;
        continue;
      }
      retries = 0;
    }
    if (!local || !this.catchUpCurrent(epoch, generation)) return;
    if (local.seq === target.seq && !bytesEqual(local.hash, target.hash)) {
      this.failFork(local, target);
      return;
    }
    if (local.seq < target.seq) {
      console.warn(
        `[uplink] key-log catch-up incomplete local=${local.seq.toString()} target=${target.seq.toString()}`
      );
      this.tearDownLink('key-log-catch-up-incomplete');
      return;
    }
    console.warn(
      `[uplink] key-log catch-up result local=${local.seq.toString()} target=${target.seq.toString()}`
    );
    this.finishNodeList(epoch, generation);
  }

  private async retryOrTearDown(retries: number, reason: string): Promise<boolean> {
    if (retries > this.keyLogRetryLimit) {
      this.tearDownLink(reason);
      return false;
    }
    try {
      await this.scheduler.sleep(backoffDelayMs(retries - 1, 200, 2_000));
      return true;
    } catch {
      return false;
    }
  }

  async queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    return this.lastKeyLogHead;
  }

  async queryKeyLogAt(
    seq: bigint,
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null> {
    if (!this.link || this.state !== 'online' || this.pendingKeyLog || !this.isAuthenticated()) {
      return null;
    }
    let records: UplinkKeyLogRecord[];
    try {
      records = await this.requestKeyLog(seq, timeoutMs);
    } catch {
      return null;
    }
    const found = records.find((row) => row.seq === seq);
    return found ? { bytes: found.bytes, sig: found.sig } : null;
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<UplinkKeyLogAck> {
    if (!this.link || this.state !== 'online' || !this.isAuthenticated()) {
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

  private async pushMissingToHub(hubSeq: bigint): Promise<boolean> {
    const listed = await this.keyLogApplier.list?.(this.userId, hubSeq + 1n);
    if (!listed || listed.length === 0) return false;
    const sorted = [...listed].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (const row of sorted) {
      if (row.seq <= hubSeq) continue;
      const ack = await this.appendAndAck({ bytes: row.bytes, sig: row.sig }, this.keyLogTimeoutMs);
      if (!ack.ok) return false;
    }
    return true;
  }

  private requestKeyLog(
    fromSeq: bigint,
    timeoutMs = this.keyLogTimeoutMs
  ): Promise<UplinkKeyLogRecord[]> {
    if (!this.link || !this.isAuthenticated()) {
      return Promise.reject(new Error('uplink-offline'));
    }
    if (this.pendingKeyLog) {
      return Promise.reject(new Error('key-log-pending'));
    }
    const id = crypto.randomUUID();
    console.warn(`[uplink] key.log.req from_seq=${fromSeq.toString()} id=${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingKeyLog?.id === id) {
          this.pendingKeyLog = null;
          reject(new Error('key-log-timeout'));
        }
      }, timeoutMs);
      this.pendingKeyLog = {
        id,
        resolve: (rows) => {
          clearTimeout(timer);
          resolve(rows);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        this.link?.ctl.send(encodeUplinkCtl({ t: 'key.log.req', from_seq: fromSeq, id }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingKeyLog = null;
        reject(err instanceof Error ? err : new Error('key-log-send-failed'));
      }
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
      this.sendStatusIfChanged();
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    this.heartbeat?.clear();
    this.heartbeat = null;
    this.missedPongs = 0;
  }

  private resetConnectionState(reason = 'reconnect'): void {
    this.stopHeartbeat();
    const pending = this.pendingKeyLog;
    this.pendingKeyLog = null;
    pending?.reject(new Error(reason));
    const acks = [...this.pendingAcks.entries()];
    this.pendingAcks.clear();
    for (const [id, waiter] of acks) {
      waiter({ t: 'key.log.ack', id, ok: false, error: 'offline' });
    }
    this.authPhase = 'idle';
    this.authenticatedGeneration = 0;
    this.latestList = null;
    this.catchUpChain = Promise.resolve();
    this.listVersionWatermark = Number.NEGATIVE_INFINITY;
    this.keyLogResMissingIdWarned = false;
    this.lastStatusJson = '';
    this.missedPongs = 0;
    if (this.state === 'online') {
      this.setState('connecting');
    }
  }

  private tearDownLink(reason: string): void {
    this.resetConnectionState(reason);
    const link = this.link;
    this.link = null;
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

  private warnCtl(kind: 'decode' | 'handler', type: string, length: number, err: unknown): void {
    const now = this.scheduler.now();
    if (now - this.lastCtlWarnAt < UPLINK_CTL_WARN_INTERVAL_MS) return;
    this.lastCtlWarnAt = now;
    const safeType = sanitizeUplinkCtlType(type);
    const code = mapUplinkCtlError(kind, err);
    console.warn(`[uplink] ctl ${kind} error type=${safeType} len=${length} err=${code}`);
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

export function sanitizeUplinkCtlType(type: string): string {
  return (UPLINK_CTL_TYPES as readonly string[]).includes(type) ? type : 'unknown';
}

export function stripCtlControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

export function mapUplinkCtlError(kind: 'decode' | 'handler', err: unknown): string {
  const message = stripCtlControlChars(err instanceof Error ? err.message : String(err));
  if (message.startsWith('unknown uplink ctl')) return 'unknown_type';
  if (message === 'ctl too large') return 'ctl_too_large';
  if (message === 'ctl too deep') return 'ctl_too_deep';
  if (message === 'ctl string too long' || message === 'ctl array too long') return 'ctl_too_long';
  if (message.startsWith('ctl field')) return 'invalid_field';
  if (message.startsWith('ctl ')) return 'invalid_ctl';
  if (kind === 'decode') return 'decode_error';
  return 'handler_error';
}

function ctlTypeHint(bytes: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as { t?: unknown }).t;
      if (typeof t === 'string') return t;
    }
  } catch {
    // ignore
  }
  return '';
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
