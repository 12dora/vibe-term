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
  /** After this many successful sends, further sends return false until `emitLow()`. */
  succeedsBeforeBlock = Number.POSITIVE_INFINITY;
  blockSend = false;
  /** When a send is blocked, also close the channel (mid-frame failure). */
  closeOnBlockedSend = false;
  private successCount = 0;
  private pendingMessages: Array<string | Buffer | ArrayBuffer> = [];
  private readonly openCbs: Array<() => void> = [];
  private readonly closedCbs: Array<() => void> = [];
  private readonly errorCbs: Array<(err: string) => void> = [];
  private readonly lowCbs: Array<() => void> = [];
  private readonly messageCbs: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];

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
    for (const cb of this.openCbs) cb();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    const peer = this.peer;
    this.peer = null;
    for (const cb of this.closedCbs) cb();
    if (peer && !peer.closed) peer.close();
  }

  sendMessage(msg: string): boolean {
    return this.dispatch(new TextEncoder().encode(msg));
  }

  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
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
    this.lowCbs.push(cb);
  }

  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
    if (this.open) cb();
  }

  onClosed(cb: () => void): void {
    this.closedCbs.push(cb);
  }

  onError(cb: (err: string) => void): void {
    this.errorCbs.push(cb);
  }

  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.messageCbs.length = 0;
    this.messageCbs.push(cb);
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next !== undefined) cb(next);
    }
  }

  emitLow(): void {
    this.blockSend = false;
    this.succeedsBeforeBlock = Number.POSITIVE_INFINITY;
    for (const cb of this.lowCbs) cb();
  }

  emitMessage(msg: string | Buffer | ArrayBuffer): void {
    for (const cb of this.messageCbs) cb(msg);
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
    const peer = this.peer;
    if (peer?.open && !peer.closed) {
      const payload = Buffer.from(copy);
      if (peer.messageCbs.length === 0) peer.pendingMessages.push(payload);
      else for (const cb of peer.messageCbs) cb(payload);
    }
    return true;
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
  private readonly localDescCbs: Array<(sdp: string, type: string) => void> = [];
  private readonly localCandCbs: Array<(candidate: string, mid: string) => void> = [];
  private readonly dataChannelCbs: Array<(dc: DataChannelLike) => void> = [];
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
      return;
    }
    this.emitLocal(descType);
  }

  setRemoteDescription(sdp: string, type: string): void {
    const remoteId = parseSdpField(sdp, 'fake-id');
    const remote = remoteId ? (fakePcs.get(remoteId) ?? null) : null;
    this.remote = remote;
    const fpMatch = sdp.match(/(?:^|\r?\n)a=fingerprint:([^\s]+)\s+([0-9A-Fa-f:]+)/im);
    if (fpMatch?.[1] && fpMatch[2]) {
      this.remoteFp = { algorithm: fpMatch[1].toLowerCase(), value: fpMatch[2] };
    }
    if (type === 'offer' || type === 'unspec') {
      this.emitLocal('answer');
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

  createDataChannel(label: string, _config?: unknown): FakeDataChannel {
    const dc = new FakeDataChannel(label);
    this.created.push(dc);
    if (!this.localSdp) this.emitLocal('offer');
    this.tryOpen();
    this.remote?.tryOpen();
    return dc;
  }

  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescCbs.push(cb);
    if (this.localSdp) cb(this.localSdp.sdp, this.localSdp.type);
  }

  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.localCandCbs.push(cb);
  }

  onDataChannel(cb: (dc: DataChannelLike) => void): void {
    this.dataChannelCbs.push(cb);
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
    const sdp = this.fingerprintSdp();
    this.localSdp = { type, sdp };
    for (const cb of this.localDescCbs) cb(sdp, type);
    for (const cb of this.localCandCbs) cb('candidate:1 1 UDP 1 127.0.0.1 9 typ host', '0');
  }

  private tryOpen(): void {
    const remote = this.remote;
    if (!remote || !this.localSdp || !remote.localSdp) return;
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
      for (const cb of answerer.dataChannelCbs) cb(remoteDc);
    }
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
