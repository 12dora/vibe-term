import type { StunDoh, StunLookup, StunResolveVia } from './stun-resolver';

export type StunProbeResult = {
  url: string;
  ok: boolean;
  rttMs: number;
  mappedAddress?: string;
  error?: string;
  resolvedIp?: string;
  via?: StunResolveVia;
  fakeIp?: boolean;
  errorResponse?: boolean;
  skipped?: 'unsupported-scheme';
};

export type StunProbeRecord = StunProbeResult & { probedAt: number };

export type StunRinfo = { address: string; port: number };

export type StunUdpSocket = {
  send(
    msg: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void;
  on(event: 'message', listener: (msg: Uint8Array, rinfo: StunRinfo) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(): void;
  unref?(): void;
};

export type StunProbeDeps = {
  lookup?: StunLookup;
  doh?: StunDoh;
  createSocket?: (family: number) => StunUdpSocket;
  now?: () => number;
  timeoutMs?: number;
  randomTxid?: () => Uint8Array;
  rtoMs?: number;
  signal?: AbortSignal;
};
