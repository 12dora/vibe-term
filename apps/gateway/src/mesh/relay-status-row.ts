import type { RelayUplinkClient } from './relay-uplink-client';
import type { PooledUplink } from './types';

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

export function buildRelayStatusRow(
  row: { url: string; priority: number; kicked: boolean },
  attachedUrl: string | null,
  client: RelayUplinkClient | null,
  live: PooledUplink | null,
  candidates: RelayStatusCandidate[]
) {
  const attached = attachedUrl === row.url;
  const cand = candidates.find((entry) => entry.publicUrl === row.url);
  const err = relayLinkError({
    attached,
    clientError: live?.lastConnectError,
    candidate: {
      lastError: cand?.lastError ?? null,
      lastErrorAt: cand?.lastErrorAt ?? null,
    },
  });
  return {
    url: row.url,
    priority: row.priority,
    online: attached && client?.state === 'online',
    attached,
    rttMs: attached ? (client?.rttMs ?? null) : null,
    lastError: err.lastError,
    lastErrorAt: err.lastErrorAt,
    kicked: row.kicked,
  };
}
