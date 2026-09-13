import { membersProbeSnapshot } from './port-reach';
import { classifyRelayLinkError } from './relay-link-error';
import type { RelayPresence } from './relay-presence';
import type { RelayUplinkClient } from './relay-uplink-client';
import { matchingTurnProbe } from './rtc/stun-effective';
import { tcpSamplingTrusted } from './tcp-sampling-trust';
import type { PooledUplink } from './types';
import { isUplinkPathRerace, uplinkPathView } from './uplink-path-sampler';

export type RelayCandidateError = {
  lastError: string | null;
  lastErrorAt: number | null;
};

export type RelayStatusCandidate = {
  publicUrl: string;
  lastError?: string | null;
  lastErrorAt?: number | null;
};

export function relayLinkError(input: {
  attached: boolean;
  clientError: { reason: string; at: number } | null | undefined;
  candidate: RelayCandidateError | null | undefined;
}): RelayCandidateError {
  if (input.attached) {
    return {
      lastError: input.clientError?.reason ?? null,
      lastErrorAt: input.clientError?.at ?? null,
    };
  }
  return {
    lastError: input.candidate?.lastError ?? null,
    lastErrorAt: input.candidate?.lastErrorAt ?? null,
  };
}

export type RelayTurnMembersView = { ok: number; total: number; updatedAt: number };

export type RelayStatusTurnView = {
  url: string;
  probeOk: boolean | null;
  members?: RelayTurnMembersView;
  localHint?: 'tun';
};

export type RelayStatusRowKeyLog = { diverged?: boolean };

export type RelayStatusRowExtras = {
  /** 该行当前已认证（primary 或 secondary）。缺省时退回「仅 attached 行」。 */
  connected?: boolean;
  rttMs?: number | null;
  peersOnline?: number | null;
  turn?: RelayStatusTurnView | null;
  lastError?: { reason: string; at: number } | null;
  keyLog?: RelayStatusRowKeyLog;
  pathBestMs?: number;
  reraces?: number;
};

function statusRowOnline(
  attached: boolean,
  client: Pick<RelayUplinkClient, 'state' | 'rttMs'> | null,
  extras?: RelayStatusRowExtras
): boolean {
  if (extras?.connected !== undefined) return extras.connected;
  return attached && client?.state === 'online';
}

function statusRowRttMs(
  online: boolean,
  client: Pick<RelayUplinkClient, 'state' | 'rttMs'> | null,
  extras?: RelayStatusRowExtras
): number | null {
  if (!online) return null;
  if (extras?.rttMs !== undefined) return extras.rttMs;
  return client?.rttMs ?? null;
}

export function buildRelayStatusRow(
  row: { url: string; priority: number; kicked: boolean; kickedReason?: string | null },
  attachedUrl: string | null,
  client: Pick<RelayUplinkClient, 'state' | 'rttMs'> | null,
  live: Pick<PooledUplink, 'lastConnectError'> | null,
  candidates: RelayStatusCandidate[],
  extras?: RelayStatusRowExtras
) {
  const attached = attachedUrl === row.url;
  const online = statusRowOnline(attached, client, extras);
  const cand = candidates.find((entry) => entry.publicUrl === row.url);
  const errors = statusRowErrors(online, attached, extras, live, cand);
  return {
    url: row.url,
    priority: row.priority,
    online,
    attached,
    role: online ? (attached ? 'primary' : 'secondary') : null,
    rttMs: statusRowRttMs(online, client, extras),
    peersOnline: online ? (extras?.peersOnline ?? null) : null,
    turn: online ? (extras?.turn ?? null) : null,
    ...errors,
    kicked: row.kicked,
    kickedReason: row.kicked ? (row.kickedReason ?? null) : null,
    ...(extras?.keyLog?.diverged === true ? { keyLog: { diverged: true as const } } : {}),
    ...(extras?.pathBestMs != null ? { pathBestMs: extras.pathBestMs } : {}),
    ...(extras?.reraces != null ? { reraces: extras.reraces } : {}),
  };
}

function statusRowErrors(
  online: boolean,
  attached: boolean,
  extras: RelayStatusRowExtras | undefined,
  live: Pick<PooledUplink, 'lastConnectError'> | null,
  cand: RelayStatusCandidate | undefined
) {
  const err = relayLinkError({
    attached: extras?.lastError !== undefined || attached,
    clientError: extras?.lastError !== undefined ? extras.lastError : live?.lastConnectError,
    candidate: {
      lastError: cand?.lastError ?? null,
      lastErrorAt: cand?.lastErrorAt ?? null,
    },
  });
  if (isUplinkPathRerace(err.lastError)) {
    return { lastError: null, lastErrorCode: null, lastErrorAt: null };
  }
  const code = classifyRelayLinkError(err.lastError);
  if (online || code === null) {
    return { lastError: null, lastErrorCode: null, lastErrorAt: null };
  }
  return { lastError: err.lastError, lastErrorCode: code, lastErrorAt: err.lastErrorAt };
}

export function turnViewFromRtc(
  rtc: { turn?: { url?: string } | null } | null | undefined,
  probeOk: boolean | null = null
): RelayStatusTurnView | null {
  const url = rtc?.turn?.url;
  if (!url) return null;
  return { url, probeOk };
}

/** 给本机探测结论叠上舰队 tally（不含自己）与 TUN 提示；新字段全可选。 */
export function enrichRelayTurnView(
  base: { url: string; probeOk: boolean | null } | null,
  relayUrl: string,
  opts?: { selfId?: string; now?: number }
): RelayStatusTurnView | null {
  if (!base) return null;
  const members = membersProbeSnapshot(relayUrl, { excludeId: opts?.selfId });
  const localHint =
    base.probeOk === false && tcpSamplingTrusted(opts?.now ?? Date.now()) === false
      ? ('tun' as const)
      : undefined;
  return {
    url: base.url,
    probeOk: base.probeOk,
    ...(members ? { members } : {}),
    ...(localHint ? { localHint } : {}),
  };
}

export function collectRelayStatusRows(input: {
  rows: Array<{ url: string; priority: number; kicked: boolean; kickedReason?: string | null }>;
  attachedUrl: string | null;
  primary: RelayUplinkClient | null;
  live: Pick<PooledUplink, 'lastConnectError'> | null;
  candidates: RelayStatusCandidate[];
  secondaryOf: (url: string) => RelayUplinkClient | null;
  peersOnlineOn: (url: string) => number | null;
  turnOf: (client: RelayUplinkClient | null, relayUrl: string) => RelayStatusTurnView | null;
}) {
  return input.rows.map((row) => {
    const attached = input.attachedUrl === row.url;
    const client = attached ? input.primary : input.secondaryOf(row.url);
    const connected = client?.state === 'online';
    return buildRelayStatusRow(row, input.attachedUrl, client, input.live, input.candidates, {
      connected,
      rttMs: client?.rttMs ?? null,
      peersOnline: connected ? input.peersOnlineOn(row.url) : null,
      turn: input.turnOf(client, row.url),
      ...(client && !attached ? { lastError: client.lastConnectError } : {}),
      ...(client?.keyLog.diverged === true ? { keyLog: { diverged: true as const } } : {}),
      ...uplinkPathView(row.url),
    });
  });
}

export function buildRelayStatusPayload(input: {
  mode: string;
  tenantId: string | null;
  rows: Array<{ url: string; priority: number; kicked: boolean; kickedReason?: string | null }>;
  attachedUrl: string | null;
  primary: RelayUplinkClient | null;
  live: Pick<PooledUplink, 'lastConnectError'> | null;
  candidates: RelayStatusCandidate[];
  secondaryOf: (url: string) => RelayUplinkClient | null;
  presence: RelayPresence | null;
  multiAttach: boolean;
  metaEpoch: number;
  reauthRequired: boolean;
  readmitPending: number;
  metaKeyLagging: unknown;
}) {
  const relays = collectRelayStatusRows({
    rows: input.rows,
    attachedUrl: input.attachedUrl,
    primary: input.primary,
    live: input.live,
    candidates: input.candidates,
    secondaryOf: input.secondaryOf,
    peersOnlineOn: (url) => input.presence?.peersOnlineOn(url) ?? null,
    turnOf: (rowClient, relayUrl) => {
      const turn = turnViewFromRtc(rowClient?.rtc);
      if (!turn) return null;
      const probe = matchingTurnProbe(rowClient?.rtc.turn ?? null);
      return enrichRelayTurnView({ url: turn.url, probeOk: probe ? probe.ok : null }, relayUrl, {
        selfId: rowClient?.identity.nodeId,
      });
    },
  });
  const secondaryAwaiting = input.rows.some(
    (row) => input.secondaryOf(row.url)?.awaitingToken === true
  );
  const nodesViaRelay = input.presence
    ? input.presence.onlineUnion().size
    : (input.primary?.nodesViaRelay ?? 0);
  return {
    mode: input.mode,
    tenantId: input.tenantId,
    relays,
    metaEpoch: input.metaEpoch,
    nodesViaRelay,
    multiAttach: input.multiAttach,
    reauthRequired: input.reauthRequired,
    awaitingToken:
      input.primary?.awaitingToken === true ||
      secondaryAwaiting ||
      input.rows.some((row) => row.kicked && row.kickedReason === 'password_rotated'),
    readmitPending: input.readmitPending,
    metaKeyLagging: input.metaKeyLagging,
    quota: input.primary?.quota ?? null,
    keyLog: input.primary?.keyLogHealth() ?? { skipped: 0, blockedSeq: null, caughtUp: false },
  };
}
