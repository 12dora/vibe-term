export interface HubKeyLogSource {
  head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }>;
  list(
    userId: string,
    fromSeq?: bigint
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>;
  append(
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array }
  ): Promise<{ ok: true; seq: bigint; hash: Uint8Array } | { ok: false; error: string }>;
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
};

export type HubAuthResult = {
  userId: string;
  entryNodeId: string;
};

export type HubAuthenticate = (
  req: Request
) => HubAuthResult | null | Promise<HubAuthResult | null>;

export const HUB_UPLINK_PATH = '/hub/uplink';
export const HUB_UPLINK_WS_KIND = 'hub-uplink';

export const HUB_HEARTBEAT_INTERVAL_MS = 15_000;
export const HUB_HEARTBEAT_MISS_LIMIT = 3;

export type HubUplinkSocketData = {
  kind: typeof HUB_UPLINK_WS_KIND;
};
