import type { BindUdpFn } from './turn-udp';

export type TurnCredentialLookup = (username: string) => string | null;
export type TurnServerOptions = {
  listenHost?: string;
  listenPort: number;
  relayPortRange: { begin: number; end: number };
  externalIp: string;
  realm: string;
  credentials: TurnCredentialLookup;
  maxAllocations?: number;
  maxAllocationsPerUser?: number;
  maxLifetimeSec?: number;
  deniedPeerCidrs?: readonly string[];
  /** 缺省 true：拒绝中继自身外网 IP、监听地址与本机网卡地址作为 peer。 */
  denySelfAddresses?: boolean;
  bytesPerSecPerAllocation?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** 控制面 UDP bind，缺省系统 dgram。 */
  bindUdp?: BindUdpFn;
};
export type TurnServerStats = {
  listening: boolean;
  port: number;
  bindHost: string;
  externalIp: string;
  allocations: number;
  permissions: number;
  channels: number;
  bytesRelayedIn: number;
  bytesRelayedOut: number;
  authFailures: number;
  deniedPeers: number;
  bindingRequests: number;
  startedAt: number | null;
  droppedNoPermission?: number;
  droppedRateLimit?: number;
  droppedOversized?: number;
  droppedUnauthRateLimit?: number;
};
export type TurnServer = {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  snapshot(): TurnServerStats;
  /** 已有 allocation 保留 relay 端口；之后的 Allocate 使用新的 XOR-RELAYED-ADDRESS。每次调用都重算本机拒绝集。 */
  setExternalIp(ip: string): void;
};
export { createTurnServer } from './turn-server';
export function turnUrlFor(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `turn:${h}:${port}?transport=udp`;
}
