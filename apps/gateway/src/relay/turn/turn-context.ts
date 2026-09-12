import type { AllocationTable } from './allocation-table';
import type { TurnCredentialLookup, TurnServerStats } from './index';
import type { NonceStore } from './turn-auth';
import type { UnauthResponseLimiter } from './turn-unauth-limit';

export type SocketAddress = { address: string; port: number };

export type ResolvedTurnOptions = {
  listenHost: string;
  listenPort: number;
  relayPortRange: { begin: number; end: number };
  externalIp: string;
  realm: string;
  credentials: TurnCredentialLookup;
  maxAllocations: number;
  maxAllocationsPerUser: number;
  maxLifetimeSec: number;
  deniedPeerCidrs: readonly string[];
  bytesPerSecPerAllocation: number;
  log: (line: string) => void;
  now: () => number;
};

export type MutableStats = TurnServerStats & {
  droppedNoPermission: number;
  droppedRateLimit: number;
  droppedOversized: number;
  droppedUnauthRateLimit: number;
};

export type TurnContext = {
  options: ResolvedTurnOptions;
  stats: MutableStats;
  table: AllocationTable;
  nonce: NonceStore;
  unauthLimit: UnauthResponseLimiter;
  denied: (address: string) => boolean;
  send: (buf: Buffer, addr: SocketAddress) => void;
};
