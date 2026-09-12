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
  bytesPerSecPerAllocation?: number;
  log?: (line: string) => void;
  now?: () => number;
};
export type TurnServerStats = {
  listening: boolean;
  port: number;
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
};
export { createTurnServer } from './turn-server';
export function turnUrlFor(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `turn:${h}:${port}?transport=udp`;
}
