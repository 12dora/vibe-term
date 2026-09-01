export const HUB_RELAY_KIND = 'hub-relay';
export const HUB_RELAY_MAX_HOP = 2;

const NODE_ID_HEX = /^[0-9a-f]{32}$/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type HubRelayOpen = {
  kind: typeof HUB_RELAY_KIND;
  to: string;
  from: string;
  originHubId: string;
  visitedHubIds: string[];
  hop: number;
};

export type HubRelayReject =
  | 'invalid'
  | 'unauthorized'
  | 'hop'
  | 'loop'
  | 'revoked'
  | 'unknown-target'
  | 'cross-user'
  | 'offline';

function normId(id: string): string {
  return id.trim().toLowerCase();
}

function isNodeId(id: unknown): id is string {
  return typeof id === 'string' && NODE_ID_HEX.test(id);
}

export function encodeHubRelayOpen(open: HubRelayOpen): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      kind: HUB_RELAY_KIND,
      to: normId(open.to),
      from: normId(open.from),
      originHubId: normId(open.originHubId),
      visitedHubIds: open.visitedHubIds.map(normId),
      hop: open.hop,
    })
  );
}

export function parseHubRelayOpen(payload: Uint8Array): HubRelayOpen | null {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.kind !== HUB_RELAY_KIND) return null;
    if (!isNodeId(obj.to) || !isNodeId(obj.from) || !isNodeId(obj.originHubId)) return null;
    if (!Array.isArray(obj.visitedHubIds) || obj.visitedHubIds.some((id) => !isNodeId(id))) {
      return null;
    }
    if (typeof obj.hop !== 'number' || !Number.isInteger(obj.hop) || obj.hop < 1) return null;
    return {
      kind: HUB_RELAY_KIND,
      to: normId(obj.to),
      from: normId(obj.from),
      originHubId: normId(obj.originHubId),
      visitedHubIds: obj.visitedHubIds.map((id) => normId(id as string)),
      hop: obj.hop,
    };
  } catch {
    return null;
  }
}

export function validateHubRelay(input: {
  to: string;
  from: string;
  originHubId: string;
  visitedHubIds: string[];
  hop: number;
  peerHubId: string;
  isAuthorizedHub: (id: string) => boolean;
  targetLocal: boolean;
  sameUser: boolean;
  sourceRevoked: boolean;
  targetKnown: boolean;
}): { ok: true } | { ok: false; reason: HubRelayReject } {
  if (!isNodeId(input.to) || !isNodeId(input.from) || !isNodeId(input.originHubId)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!input.isAuthorizedHub(input.originHubId) || !input.isAuthorizedHub(input.peerHubId)) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (input.hop < 1 || input.hop > HUB_RELAY_MAX_HOP) {
    return { ok: false, reason: 'hop' };
  }
  const seen = new Set<string>();
  for (const raw of input.visitedHubIds) {
    if (!isNodeId(raw)) return { ok: false, reason: 'invalid' };
    const id = normId(raw);
    if (seen.has(id)) return { ok: false, reason: 'loop' };
    seen.add(id);
  }
  if (input.sourceRevoked) return { ok: false, reason: 'revoked' };
  if (!input.targetKnown) return { ok: false, reason: 'unknown-target' };
  if (!input.sameUser) return { ok: false, reason: 'cross-user' };
  if (!input.targetLocal) return { ok: false, reason: 'offline' };
  return { ok: true };
}

export function nextHubRelayHop(
  open: HubRelayOpen,
  selfHubId: string
): { ok: true; open: HubRelayOpen } | { ok: false; reason: HubRelayReject } {
  const self = normId(selfHubId);
  if (open.visitedHubIds.some((id) => id === self)) return { ok: false, reason: 'loop' };
  const hop = open.hop + 1;
  if (hop > HUB_RELAY_MAX_HOP) return { ok: false, reason: 'hop' };
  return {
    ok: true,
    open: {
      kind: HUB_RELAY_KIND,
      to: open.to,
      from: open.from,
      originHubId: open.originHubId,
      visitedHubIds: [...open.visitedHubIds, self],
      hop,
    },
  };
}
