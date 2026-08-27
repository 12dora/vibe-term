import { decodeCertificate, encodeBase64url, randomBytes, verifyEd25519 } from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { patchNode } from './node-persistence';
import type { NodeRegistry } from './node-registry';
import {
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_HEARTBEAT_MISS_LIMIT,
  type HubKeyLogSource,
  type HubRuntimeConfig,
} from './types';
import {
  type NodeListMessage,
  type RtcSignalMessage,
  type UplinkCtlMessage,
  b64urlToBytes,
  bytesToB64url,
  decodeUplinkCtl,
  encodeUplinkCtl,
  seqToWire,
} from './uplink-protocol';

export type RtcSessionRegistration = {
  fromNodeId: string;
  toNodeId: string;
};

export type UplinkServerOptions = {
  db: AuthDb;
  userStore: UserStore;
  keyLogSource: HubKeyLogSource;
  registry: NodeRegistry;
  config: HubRuntimeConfig;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
};

type PendingAuth = {
  nonce: Uint8Array;
};

type LiveConnection = {
  nodeId: string;
  userId: string;
  link: LinkSession;
  generation: number;
  misses: number;
  heartbeat: ReturnType<typeof setInterval> | null;
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export class UplinkServer {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogSource: HubKeyLogSource;
  readonly registry: NodeRegistry;
  private readonly config: HubRuntimeConfig;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissLimit: number;
  private readonly pending = new WeakMap<LinkSession, PendingAuth>();
  private readonly live = new Map<LinkSession, LiveConnection>();
  private readonly rtcSessions = new Map<string, RtcSessionRegistration>();
  private listVersion = 0;

  constructor(opts: UplinkServerOptions) {
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.keyLogSource = opts.keyLogSource;
    this.registry = opts.registry;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissLimit = opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT;
  }

  accept(link: LinkSession): void {
    const nonce = randomBytes(32);
    this.pending.set(link, { nonce });
    this.send(link, { t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    link.ctl.onMessage((bytes) => {
      void this.onCtl(link, bytes);
    });
    link.onStream((stream) => {
      void this.onIncomingStream(link, stream);
    });
    void link.closed.then(() => {
      this.onLinkClosed(link);
    });
  }

  registerRtcSession(rtcSession: string, reg: RtcSessionRegistration): void {
    this.rtcSessions.set(rtcSession, reg);
  }

  unregisterRtcSession(rtcSession: string): void {
    this.rtcSessions.delete(rtcSession);
  }

  sendTo(nodeId: string, msg: UplinkCtlMessage): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry?.authenticated) return false;
    this.send(entry.link, msg);
    return true;
  }

  async broadcastNodeList(userId: string): Promise<void> {
    const msg = await this.buildNodeList(userId);
    for (const entry of this.registry.listForBroadcast(userId)) {
      this.send(entry.link, msg);
    }
  }

  disconnect(nodeId: string, reason = 'disconnected'): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry) return false;
    entry.link.close(reason);
    return true;
  }

  stop(): void {
    for (const live of this.live.values()) {
      this.clearHeartbeat(live);
    }
    this.live.clear();
    this.registry.closeAll('hub-stop');
  }

  private send(link: LinkSession, msg: UplinkCtlMessage): void {
    link.ctl.send(encodeUplinkCtl(msg));
  }

  private async onCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    let msg: UplinkCtlMessage;
    try {
      msg = decodeUplinkCtl(bytes);
    } catch {
      return;
    }
    const live = this.live.get(link);
    if (!live) {
      if (msg.t === 'auth.response') {
        await this.handleAuthResponse(link, msg.node_id, msg.sig);
      }
      return;
    }
    live.misses = 0;
    this.registry.touch(live.nodeId, this.now());
    switch (msg.t) {
      case 'ping':
        this.send(link, { t: 'pong' });
        return;
      case 'pong':
        return;
      case 'node.status':
        await this.handleNodeStatus(live, msg);
        return;
      case 'key.log.req':
        await this.handleKeyLogReq(live, msg.from_seq);
        return;
      case 'key.log.append':
        await this.handleKeyLogAppend(live, msg.bytes, msg.sig);
        return;
      case 'rtc.signal':
        this.handleRtcSignal(live, msg);
        return;
      default:
        return;
    }
  }

  private async handleAuthResponse(
    link: LinkSession,
    nodeId: string,
    sigB64: string
  ): Promise<void> {
    const pending = this.pending.get(link);
    this.pending.delete(link);
    if (!pending) {
      link.close('auth-timeout');
      return;
    }
    const cert = this.userStore.getCert(nodeId);
    if (!cert) {
      link.close('unknown-cert');
      return;
    }
    if (cert.revokedLogSeq !== null) {
      link.close('revoked');
      return;
    }
    const nodeRow = this.userStore.getNode(nodeId);
    if (nodeRow?.status === 'revoked') {
      link.close('revoked');
      return;
    }
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      link.close('bad-cert');
      return;
    }
    let sig: Uint8Array;
    try {
      sig = b64urlToBytes(sigB64, 64);
    } catch {
      link.close('bad-sig');
      return;
    }
    if (!verifyEd25519(sig, pending.nonce, edPk)) {
      link.close('unauthorized');
      return;
    }
    const userId = cert.userId;
    const name = nodeRow?.name ?? nodeId;
    const registered = this.registry.put({
      nodeId,
      userId,
      link,
      meta: this.registry.emptyMeta(name),
      lastSeen: this.now(),
      authenticated: true,
    });
    const live: LiveConnection = {
      nodeId,
      userId,
      link,
      generation: registered.generation,
      misses: 0,
      heartbeat: null,
    };
    this.live.set(link, live);
    this.startHeartbeat(live);
    this.send(link, { t: 'auth.ok' });
    await this.broadcastNodeList(userId);
  }

  private async handleNodeStatus(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'node.status' }>
  ): Promise<void> {
    const now = this.now();
    const inventoryJson = stringifyJson(msg.inventory);
    const endpointsJson = stringifyJson(msg.endpoints);
    const existing = this.userStore.getNode(live.nodeId);
    if (!existing) {
      this.userStore.createNode({
        id: live.nodeId,
        userId: live.userId,
        name: live.nodeId,
        status: 'enrolled',
        lastSeenAt: now,
        version: msg.version,
        directCapable: msg.direct_capable,
        inventoryJson,
        inventoryVersion: 1,
        endpointsJson,
        now,
      });
    } else {
      patchNode(this.db, live.nodeId, {
        lastSeenAt: now,
        version: msg.version,
        directCapable: msg.direct_capable,
        inventoryJson,
        inventoryVersion: existing.inventoryVersion + 1,
        endpointsJson,
      });
    }
    this.registry.updateMeta(
      live.nodeId,
      {
        version: msg.version,
        tmux: msg.tmux,
        directCapable: msg.direct_capable,
        inventory: msg.inventory,
        endpoints: msg.endpoints,
      },
      now
    );
    await this.broadcastNodeList(live.userId);
  }

  private async handleKeyLogReq(live: LiveConnection, fromSeqWire: number | string): Promise<void> {
    const fromSeq = BigInt(fromSeqWire);
    const records = await this.keyLogSource.list(live.userId, fromSeq);
    this.send(live.link, {
      t: 'key.log.res',
      records: records.map((r) => ({
        seq: seqToWire(r.seq),
        bytes: bytesToB64url(r.bytes),
        sig: bytesToB64url(r.sig),
      })),
    });
  }

  private async handleKeyLogAppend(
    live: LiveConnection,
    bytesB64: string,
    sigB64: string
  ): Promise<void> {
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = b64urlToBytes(bytesB64);
      sig = b64urlToBytes(sigB64, 64);
    } catch {
      return;
    }
    const result = await this.keyLogSource.append(live.userId, { bytes, sig });
    if (!result.ok) return;
    await this.broadcastNodeList(live.userId);
  }

  private handleRtcSignal(live: LiveConnection, msg: RtcSignalMessage): void {
    const reg = this.rtcSessions.get(msg.rtcSession);
    if (!reg) return;
    if (msg.from === 'browser') {
      if (live.nodeId !== reg.fromNodeId || msg.to !== reg.toNodeId) return;
    } else if (msg.from === 'node') {
      if (live.nodeId !== reg.toNodeId || msg.to !== reg.fromNodeId) return;
    } else {
      return;
    }
    const target = this.registry.get(msg.to);
    if (!target?.authenticated) return;
    this.send(target.link, msg);
  }

  private async onIncomingStream(link: LinkSession, stream: LinkStream): Promise<void> {
    const live = this.live.get(link);
    if (!live) {
      stream.reset('unauthenticated');
      return;
    }
    const open = parseRelayOpen(stream.openPayload);
    if (!open) {
      stream.reset('invalid-relay');
      return;
    }
    const initiator = this.userStore.getNode(live.nodeId) ?? this.userStore.getCert(live.nodeId);
    const targetRow = this.userStore.getNode(open.to);
    const targetCert = this.userStore.getCert(open.to);
    const initiatorUser = initiator && 'userId' in initiator ? initiator.userId : live.userId;
    const targetUser = targetRow?.userId ?? targetCert?.userId;
    if (!targetUser || targetUser !== initiatorUser) {
      stream.reset('cross-user');
      return;
    }
    if (targetRow?.status === 'revoked' || targetCert?.revokedLogSeq !== null) {
      stream.reset('revoked');
      return;
    }
    const targetEntry = this.registry.get(open.to);
    if (!targetEntry?.authenticated) {
      stream.reset('offline');
      return;
    }
    const outboundPayload = textEncoder.encode(JSON.stringify({ ...open.raw, from: live.nodeId }));
    let outbound: LinkStream;
    try {
      outbound = await targetEntry.link.openStream(outboundPayload);
    } catch {
      stream.reset('open-failed');
      return;
    }
    pumpRelay(stream, outbound);
  }

  private startHeartbeat(live: LiveConnection): void {
    this.clearHeartbeat(live);
    live.heartbeat = setInterval(() => {
      this.beat(live);
    }, this.heartbeatIntervalMs);
  }

  private beat(live: LiveConnection): void {
    if (this.live.get(live.link) !== live) {
      this.clearHeartbeat(live);
      return;
    }
    live.misses += 1;
    if (live.misses > this.heartbeatMissLimit) {
      live.link.close('heartbeat-timeout');
      return;
    }
    this.send(live.link, { t: 'ping' });
  }

  private clearHeartbeat(live: LiveConnection): void {
    if (live.heartbeat !== null) {
      clearInterval(live.heartbeat);
      live.heartbeat = null;
    }
  }

  private onLinkClosed(link: LinkSession): void {
    this.pending.delete(link);
    const live = this.live.get(link);
    if (!live) return;
    this.live.delete(link);
    this.clearHeartbeat(live);
    const removed = this.registry.remove(live.nodeId, live.generation);
    if (!removed) return;
    patchNode(this.db, live.nodeId, { lastSeenAt: this.now() });
    void this.broadcastNodeList(live.userId);
  }

  private async buildNodeList(userId: string): Promise<NodeListMessage> {
    this.listVersion += 1;
    const head = await this.keyLogSource.head(userId);
    const online = new Map(
      this.registry.listForBroadcast(userId).map((n) => [n.nodeId, n] as const)
    );
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === userId && n.status === 'enrolled')
      .map((n) => {
        const live = online.get(n.id);
        return {
          id: n.id,
          name: n.name,
          online: Boolean(live),
          endpoints: live?.meta.endpoints ?? parseJson(n.endpointsJson, []),
          inventory: live?.meta.inventory ?? parseJson(n.inventoryJson, {}),
          direct_capable: live?.meta.directCapable ?? n.directCapable,
          version: live?.meta.version ?? n.version,
        };
      });
    return {
      t: 'node.list',
      version: this.listVersion,
      key_log_head: { seq: seqToWire(head.seq), hash: bytesToB64url(head.hash) },
      rtc: {
        stun: this.config.stun,
        turn: this.config.turn ?? null,
      },
      nodes,
    };
  }
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseRelayOpen(payload: Uint8Array): { to: string; raw: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.to !== 'string' || obj.to.length === 0) return null;
    if (typeof obj.method === 'string') return null;
    return { to: obj.to, raw: obj };
  } catch {
    return null;
  }
}

function pumpRelay(a: LinkStream, b: LinkStream): void {
  let finished = false;
  const abortBoth = (): void => {
    if (finished) return;
    finished = true;
    try {
      a.reset('relay-rst');
    } catch {
      // already closed
    }
    try {
      b.reset('relay-rst');
    } catch {
      // already closed
    }
  };
  a.onAbort(abortBoth);
  b.onAbort(abortBoth);
  void copyDirection(a, b, abortBoth);
  void copyDirection(b, a, abortBoth);
}

async function copyDirection(src: LinkStream, dst: LinkStream, onError: () => void): Promise<void> {
  const reader = src.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await dst.write(value.bytes, { head: value.head });
      }
    }
    dst.end();
  } catch {
    onError();
  }
}
