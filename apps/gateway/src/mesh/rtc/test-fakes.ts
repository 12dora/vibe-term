import type { DataChannelLike, DtlsFingerprint, PeerConnectionLike, RtcIceConfig } from './native';
import { copyBytes, toUint8Array } from './native';

export class FakeDataChannel implements DataChannelLike {
  label: string;
  open = false;
  closed = false;
  peer: FakeDataChannel | null = null;
  buffered = 0;
  maxSize = 262144;
  lowThreshold = 0;
  sent: Uint8Array[] = [];
  failNextSend = false;
  /** Queue the payload but return false (native SCTP may still accept the message). */
  acceptButReturnFalse = false;
  /** Swallow the payload after a successful send (black-hole / one-way cut). */
  dropSend = false;
  dropSendsFromReceiveCallback = false;
  inboundDepth = 0;
  /** Keep inboundDepth raised until this many ms after onMessage returns (native stack + microtasks). */
  holdReceiveCallbackMs = 0;
  /** After this many successful sends, further sends return false until `emitLow()`. */
  succeedsBeforeBlock = Number.POSITIVE_INFINITY;
  blockSend = false;
  /** When a send is blocked, also close the channel (mid-frame failure). */
  closeOnBlockedSend = false;
  private successCount = 0;
  private pendingMessages: Array<string | Buffer | ArrayBuffer> = [];
  private openCb: (() => void) | null = null;
  private closedCb: (() => void) | null = null;
  private errorCb: ((err: string) => void) | null = null;
  private lowCb: (() => void) | null = null;
  private messageCb: ((msg: string | Buffer | ArrayBuffer) => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  getLabel(): string {
    return this.label;
  }

  pair(peer: FakeDataChannel): void {
    this.peer = peer;
    peer.peer = this;
  }

  markOpen(): void {
    if (this.open || this.closed) return;
    this.open = true;
    this.openCb?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    const peer = this.peer;
    this.peer = null;
    this.closedCb?.();
    if (peer && !peer.closed) peer.close();
  }

  sendMessage(msg: string): boolean {
    if (this.dropSendsFromReceiveCallback && this.inboundDepth > 0) {
      return true;
    }
    return this.dispatch(new TextEncoder().encode(msg));
  }

  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
    if (this.dropSendsFromReceiveCallback && this.inboundDepth > 0) {
      return true;
    }
    return this.dispatch(toUint8Array(buffer));
  }

  isOpen(): boolean {
    return this.open && !this.closed;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  maxMessageSize(): number {
    return this.maxSize;
  }

  setBufferedAmountLowThreshold(bytes: number): void {
    this.lowThreshold = bytes;
  }

  onBufferedAmountLow(cb: () => void): void {
    this.lowCb = cb;
  }

  onOpen(cb: () => void): void {
    this.openCb = cb;
    if (this.open) cb();
  }

  onClosed(cb: () => void): void {
    this.closedCb = cb;
  }

  onError(cb: (err: string) => void): void {
    this.errorCb = cb;
  }

  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.messageCb = cb;
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next !== undefined) this.deliverInbound(cb, next);
    }
  }

  emitLow(): void {
    this.blockSend = false;
    this.succeedsBeforeBlock = Number.POSITIVE_INFINITY;
    this.lowCb?.();
  }

  emitMessage(msg: string | Buffer | ArrayBuffer): void {
    if (!this.messageCb) {
      this.pendingMessages.push(msg);
      return;
    }
    this.deliverInbound(this.messageCb, msg);
  }

  emitError(err: string): void {
    this.errorCb?.(err);
  }

  private dispatch(bytes: Uint8Array): boolean {
    if (this.closed || !this.open) return false;
    if (this.failNextSend) {
      this.failNextSend = false;
      return false;
    }
    if (this.blockSend || this.successCount >= this.succeedsBeforeBlock) {
      this.blockSend = true;
      if (this.closeOnBlockedSend) this.close();
      return false;
    }
    this.successCount += 1;
    const copy = copyBytes(bytes);
    this.sent.push(copy);
    if (this.acceptButReturnFalse) {
      this.buffered += copy.byteLength;
      return false;
    }
    if (this.dropSend) return true;
    const peer = this.peer;
    if (peer?.open && !peer.closed) {
      const payload = Buffer.from(copy);
      if (!peer.messageCb) peer.pendingMessages.push(payload);
      else peer.deliverInbound(peer.messageCb, payload);
    }
    return true;
  }

  deliverInbound(
    cb: (msg: string | Buffer | ArrayBuffer) => void,
    msg: string | Buffer | ArrayBuffer
  ): void {
    this.inboundDepth += 1;
    try {
      cb(msg);
    } finally {
      if (this.holdReceiveCallbackMs > 0) {
        setTimeout(() => {
          this.inboundDepth = Math.max(0, this.inboundDepth - 1);
        }, this.holdReceiveCallbackMs);
      } else {
        this.inboundDepth -= 1;
      }
    }
  }
}

const fakePcs = new Map<string, FakePeerConnection>();

function parseSdpField(sdp: string, key: string): string | null {
  const match = sdp.match(new RegExp(`(?:^|\\r?\\n)a=${key}:([^\\s]+)`, 'im'));
  return match?.[1] ?? null;
}

export class FakePeerConnection implements PeerConnectionLike {
  readonly id: string;
  readonly name: string;
  closed = false;
  fingerprint: DtlsFingerprint;
  remoteFp: DtlsFingerprint | null = null;
  remoteFpOverride: DtlsFingerprint | null = null;
  localSdp: { type: string; sdp: string } | null = null;
  created: FakeDataChannel[] = [];
  inbound: FakeDataChannel[] = [];
  pcState = 'new';
  ice = 'new';
  gathering = 'new';
  signaling = 'stable';
  private localDescCb: ((sdp: string, type: string) => void) | null = null;
  private localCandCb: ((candidate: string, mid: string) => void) | null = null;
  private dataChannelCb: ((dc: DataChannelLike) => void) | null = null;
  private stateCb: ((state: string) => void) | null = null;
  private iceCb: ((state: string) => void) | null = null;
  private gatheringCb: ((state: string) => void) | null = null;
  private remote: FakePeerConnection | null = null;

  constructor(name: string, _config: RtcIceConfig) {
    this.name = name;
    this.id = crypto.randomUUID();
    const hex = this.id.replaceAll('-', '').slice(0, 32).toUpperCase();
    const colon = hex.match(/.{2}/g)?.join(':') ?? hex;
    this.fingerprint = { algorithm: 'sha-256', value: colon };
    fakePcs.set(this.id, this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fakePcs.delete(this.id);
    for (const dc of this.created) dc.close();
  }

  setLocalDescription(type?: string): void {
    const descType = type && type !== 'unspec' ? type : (this.localSdp?.type ?? 'offer');
    if (descType === 'rollback') {
      this.localSdp = null;
      this.signaling = 'stable';
      return;
    }
    this.emitLocal(descType);
  }

  setRemoteDescription(sdp: string, type: string): void {
    const descType = type === 'unspec' ? 'offer' : type;
    if (descType === 'answer' && this.signaling !== 'have-local-offer') {
      throw new Error(`Unexpected remote answer description in signaling state ${this.signaling}`);
    }
    if (descType === 'offer' && this.signaling !== 'stable') {
      throw new Error(`Unexpected remote offer description in signaling state ${this.signaling}`);
    }
    const remoteId = parseSdpField(sdp, 'fake-id');
    const remote = remoteId ? (fakePcs.get(remoteId) ?? null) : null;
    this.remote = remote;
    const fpMatch = sdp.match(/(?:^|\r?\n)a=fingerprint:([^\s]+)\s+([0-9A-Fa-f:]+)/im);
    if (fpMatch?.[1] && fpMatch[2]) {
      this.remoteFp = { algorithm: fpMatch[1].toLowerCase(), value: fpMatch[2] };
    }
    if (descType === 'offer') {
      this.signaling = 'have-remote-offer';
      this.emitLocal('answer');
    } else if (descType === 'answer') {
      this.signaling = 'stable';
    }
    this.tryOpen();
    remote?.tryOpen();
  }

  localDescription(): { type: string; sdp: string } | null {
    return this.localSdp ?? { type: 'unspec', sdp: this.fingerprintSdp() };
  }

  remoteFingerprint(): DtlsFingerprint {
    if (this.remoteFpOverride) return this.remoteFpOverride;
    return this.remoteFp ?? { algorithm: 'sha-256', value: '00' };
  }

  addRemoteCandidate(_candidate: string, _mid: string): void {}

  state(): string {
    return this.pcState;
  }

  iceState(): string {
    return this.ice;
  }

  gatheringState(): string {
    return this.gathering;
  }

  signalingState(): string {
    return this.signaling;
  }

  onStateChange(cb: (state: string) => void): void {
    this.stateCb = cb;
  }

  onIceStateChange(cb: (state: string) => void): void {
    this.iceCb = cb;
  }

  onGatheringStateChange(cb: (state: string) => void): void {
    this.gatheringCb = cb;
  }

  getSelectedCandidatePair(): {
    local: { address: string; type: string; candidate: string };
    remote: { address: string; type: string; candidate: string };
  } | null {
    if (this.ice !== 'connected' && this.ice !== 'completed') return null;
    return {
      local: {
        address: '127.0.0.1',
        type: 'host',
        candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host',
      },
      remote: {
        address: '127.0.0.1',
        type: 'host',
        candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host',
      },
    };
  }

  emitIceState(state: string): void {
    if (this.ice === state) return;
    this.ice = state;
    this.iceCb?.(state);
  }

  emitPeerState(state: string): void {
    if (this.pcState === state) return;
    this.pcState = state;
    this.stateCb?.(state);
  }

  emitGatheringState(state: string): void {
    if (this.gathering === state) return;
    this.gathering = state;
    this.gatheringCb?.(state);
  }

  emitLocalCandidate(candidate: string, mid = '0'): void {
    this.localCandCb?.(candidate, mid);
  }

  createDataChannel(label: string, _config?: unknown): FakeDataChannel {
    const dc = new FakeDataChannel(label);
    this.created.push(dc);
    this.emitGatheringState('gathering');
    if (!this.localSdp) this.emitLocal('offer');
    this.tryOpen();
    this.remote?.tryOpen();
    return dc;
  }

  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescCb = cb;
    if (this.localSdp) cb(this.localSdp.sdp, this.localSdp.type);
  }

  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.localCandCb = cb;
  }

  onDataChannel(cb: (dc: DataChannelLike) => void): void {
    this.dataChannelCb = cb;
    for (const dc of this.inbound) cb(dc);
  }

  maxMessageSize(): number {
    return 262144;
  }

  private fingerprintSdp(): string {
    return [
      'v=0',
      `a=fake-id:${this.id}`,
      `a=fingerprint:${this.fingerprint.algorithm} ${this.fingerprint.value}`,
      'a=ice-ufrag:fake',
      'a=ice-pwd:fake',
    ].join('\r\n');
  }

  private emitLocal(type: string): void {
    if (type === 'offer') this.signaling = 'have-local-offer';
    else if (type === 'answer') this.signaling = 'stable';
    const sdp = this.fingerprintSdp();
    this.localSdp = { type, sdp };
    this.localDescCb?.(sdp, type);
    this.localCandCb?.('candidate:1 1 UDP 1 127.0.0.1 9 typ host', '0');
  }

  private tryOpen(): void {
    const remote = this.remote;
    if (!remote || !this.localSdp || !remote.localSdp) return;
    if (!this.remoteFp) this.remoteFp = remote.fingerprint;
    if (!remote.remoteFp) remote.remoteFp = this.fingerprint;
    const offerer =
      this.localSdp.type === 'offer' ? this : remote.localSdp.type === 'offer' ? remote : this;
    const answerer = offerer === this ? remote : this;
    for (const localDc of offerer.created) {
      if (localDc.peer) {
        if (!localDc.open) {
          localDc.markOpen();
          localDc.peer.markOpen();
        }
        continue;
      }
      const remoteDc = new FakeDataChannel(localDc.label);
      answerer.created.push(remoteDc);
      answerer.inbound.push(remoteDc);
      localDc.pair(remoteDc);
      localDc.markOpen();
      remoteDc.markOpen();
      answerer.dataChannelCb?.(remoteDc);
    }
    this.emitGatheringState('complete');
    remote.emitGatheringState('complete');
    this.emitIceState('connected');
    remote.emitIceState('connected');
    this.emitPeerState('connected');
    remote.emitPeerState('connected');
  }
}

export function createFakeNativeModule(opts?: {
  remoteFingerprintOverride?: DtlsFingerprint;
}): {
  module: import('./native').NodeDatachannelModule;
  connections: FakePeerConnection[];
} {
  const connections: FakePeerConnection[] = [];
  return {
    connections,
    module: {
      PeerConnection: function FakeNativePeerConnection(name: string, config: RtcIceConfig) {
        const pc = new FakePeerConnection(name, config);
        if (opts?.remoteFingerprintOverride) {
          pc.remoteFpOverride = opts.remoteFingerprintOverride;
        }
        connections.push(pc);
        return pc;
      } as unknown as import('./native').NodeDatachannelModule['PeerConnection'],
      cleanup() {},
      preload() {},
      initLogger() {},
      getLibraryVersion() {
        return 'fake';
      },
    },
  };
}

export function pairDataChannels(label = 'sess'): [FakeDataChannel, FakeDataChannel] {
  const a = new FakeDataChannel(label);
  const b = new FakeDataChannel(label);
  a.pair(b);
  a.markOpen();
  b.markOpen();
  return [a, b];
}

export class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  advance(ms: number): void {
    const target = this.nowMs + Math.max(0, ms);
    while (this.timers.size > 0) {
      let earliestId: number | null = null;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < earliestAt) {
          earliestAt = timer.at;
          earliestId = id;
        }
      }
      if (earliestId === null || earliestAt > target) break;
      this.nowMs = earliestAt;
      const timer = this.timers.get(earliestId);
      this.timers.delete(earliestId);
      timer?.fn();
    }
    this.nowMs = target;
  }
}
