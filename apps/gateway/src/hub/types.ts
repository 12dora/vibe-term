import type { KeyLogEffect, KeyLogType } from '@tmex/shared/auth';
import type { HubMode } from '@tmex/shared/uplink';

export type HubKeyLogAppendSuccess = {
  ok: true;
  seq: bigint;
  hash: Uint8Array;
  effects: KeyLogEffect[];
  record: { type: KeyLogType; payload: Uint8Array };
};

export type HubKeyLogAppendFailure = {
  ok: false;
  error: string;
};

export type HubKeyLogAppendResult = HubKeyLogAppendSuccess | HubKeyLogAppendFailure;

export interface HubKeyLogSource {
  head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }>;
  list(
    userId: string,
    fromSeq?: bigint,
    limit?: number
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>;
  append(
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array }
  ): Promise<HubKeyLogAppendResult>;
}

export type HubTurnConfig = {
  url: string;
  username: string;
  credential: string;
} | null;

export type HubRuntimeConfig = {
  publicUrl: string;
  stun: string[];
  turn?: HubTurnConfig;
  nodeId?: string;
  siteName?: string;
  mode?: HubMode;
  priority?: number;
  writerEpoch?: number;
  hubNodeId?: string;
  authorizedHubIds?: string[];
};

export type HubAuthResult = {
  userId: string;
  entryNodeId: string;
  sid?: string | null;
};

export type HubAuthenticate = (
  req: Request
) => HubAuthResult | null | Promise<HubAuthResult | null>;

export const HUB_UPLINK_PATH = '/hub/uplink';
export const HUB_UPLINK_WS_KIND = 'hub-uplink';

export const HUB_HEARTBEAT_INTERVAL_MS = 15_000;
export const HUB_HEARTBEAT_MISS_LIMIT = 3;
export const HUB_AUTH_TIMEOUT_MS = 10_000;
export const HUB_RTC_TTL_MS = 120_000;
export const HUB_RTC_MAX_SESSIONS = 1024;

export type HubUplinkSocketData = {
  kind: typeof HUB_UPLINK_WS_KIND;
};
