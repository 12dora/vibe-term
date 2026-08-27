export type DtlsFingerprint = {
  algorithm: string;
  value: string;
};

export type IceRelayType = 'TurnUdp' | 'TurnTcp' | 'TurnTls';

export type IceServer = {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: IceRelayType;
};

export type IceServerConfig = {
  stun: string[];
  turn: unknown;
};

export type RtcIceConfig = {
  iceServers: Array<string | IceServer>;
  enableIceUdpMux?: boolean;
  bindAddress?: string;
  certificatePemFile?: string;
  keyPemFile?: string;
  keyPemPass?: string;
};

export type DataChannelInitLike = {
  protocol?: string;
  negotiated?: boolean;
  id?: number;
  unordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
};

export interface DataChannelLike {
  close(): void;
  sendMessage(msg: string): boolean;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
  isOpen(): boolean;
  bufferedAmount(): number;
  maxMessageSize(): number;
  setBufferedAmountLowThreshold(bytes: number): void;
  onBufferedAmountLow(cb: () => void): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
  getLabel?(): string;
}

export interface PeerConnectionLike {
  close(): void;
  setLocalDescription?(type?: string, init?: unknown): void;
  setRemoteDescription(sdp: string, type: string): void;
  localDescription(): { type: string; sdp: string } | null;
  remoteFingerprint(): DtlsFingerprint;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: DataChannelInitLike): DataChannelLike;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onDataChannel(cb: (dc: DataChannelLike) => void): void;
  maxMessageSize(): number;
}

export interface NodeDatachannelModule {
  PeerConnection: new (peerName: string, config: RtcIceConfig) => PeerConnectionLike;
  cleanup(): void;
  preload(): void;
  initLogger(level: string, cb?: (level: string, message: string) => void): void;
  getLibraryVersion(): string;
}

export type LoadNative = () => Promise<NodeDatachannelModule | null>;

export function toUint8Array(msg: string | Buffer | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof msg === 'string') {
    return new TextEncoder().encode(msg);
  }
  if (msg instanceof Uint8Array) {
    return msg;
  }
  if (msg instanceof ArrayBuffer) {
    return new Uint8Array(msg);
  }
  return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

export function sendBinary(dc: DataChannelLike, bytes: Uint8Array): boolean {
  return dc.sendMessageBinary(Buffer.from(bytes));
}
