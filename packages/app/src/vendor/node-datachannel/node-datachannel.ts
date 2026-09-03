import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  AV1RtpPacketizer,
  Audio,
  H264RtpPacketizer,
  H265RtpPacketizer,
  IceUdpMuxListener,
  PacingHandler,
  PeerConnection,
  RtcpNackResponder,
  RtcpReceivingSession,
  RtcpSrReporter,
  RtpPacketizationConfig,
  RtpPacketizer,
  Track,
  Video,
} from './index';
import type {
  Direction,
  LogLevel,
  NalUnitSeparator,
  ObuPacketization,
  RtcConfig,
  SctpSettings,
  WebSocketServerConfiguration,
} from './types';
import type { WebSocket } from './websocket';

const require = createRequire(import.meta.url);

export interface NativeWebSocketServer {
  port(): number;
  stop(): void;
  onClient(cb: (client: WebSocket) => void): void;
}

export interface NativeBinding {
  preload(): void;
  initLogger(level: LogLevel, cb?: (level: LogLevel, message: string) => void): void;
  cleanup(): void;
  setSctpSettings(settings: SctpSettings): void;
  getLibraryVersion(): string;
  Audio: new (mid: string, dir: Direction) => Audio;
  Video: new (mid: string, dir: Direction) => Video;
  Track: new () => Track;
  DataChannel: object;
  PeerConnection: new (peerName: string, config: RtcConfig) => PeerConnection;
  IceUdpMuxListener: new (port: number, address?: string) => IceUdpMuxListener;
  RtpPacketizationConfig: new (
    ssrc: number,
    cname: string,
    payloadType: number,
    clockRate: number,
    videoOrientationId?: number
  ) => RtpPacketizationConfig;
  PacingHandler: new (bitsPerSecond: number, sendInterval: number) => PacingHandler;
  RtcpReceivingSession: new () => RtcpReceivingSession;
  RtcpNackResponder: new (maxSize?: number) => RtcpNackResponder;
  RtcpSrReporter: new (rtpConfig: RtpPacketizationConfig) => RtcpSrReporter;
  RtpPacketizer: new (rtpConfig: RtpPacketizationConfig) => RtpPacketizer;
  H264RtpPacketizer: new (
    separator: NalUnitSeparator,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => H264RtpPacketizer;
  H265RtpPacketizer: new (
    separator: NalUnitSeparator,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => H265RtpPacketizer;
  AV1RtpPacketizer: new (
    packetization: ObuPacketization,
    rtpConfig: RtpPacketizationConfig,
    maxFragmentSize?: number
  ) => AV1RtpPacketizer;
  WebSocket: new (config?: WebSocketServerConfiguration) => WebSocket;
  WebSocketServer: new (options: WebSocketServerConfiguration) => NativeWebSocketServer;
}

let binding: NativeBinding | null = null;

export function loadBindingFromPath(nativePath: string): NativeBinding {
  if (binding) {
    return binding;
  }
  if (!existsSync(nativePath)) {
    throw new Error(`node-datachannel native addon not found: ${nativePath}`);
  }
  binding = require(nativePath) as NativeBinding;
  return binding;
}

export function loadBinding(): NativeBinding {
  if (binding) {
    return binding;
  }
  const nativeDir = process.env.TMEX_NATIVE_DIR;
  if (!nativeDir) {
    throw new Error('TMEX_NATIVE_DIR is not set');
  }
  return loadBindingFromPath(join(nativeDir, 'node_datachannel.node'));
}

const nodeDataChannel = new Proxy({} as NativeBinding, {
  get(_target, prop) {
    return Reflect.get(loadBinding(), prop);
  },
});

export default nodeDataChannel;
