export type RelayTurnMembers = { ok: number; total: number; updatedAt: number };
export type RelayTurnLocalHint = 'tun';
export type RelayTurnProbe = {
  url: string;
  probeOk: boolean | null;
  members?: RelayTurnMembers;
  localHint?: RelayTurnLocalHint;
};

function normalizeTurnMembers(raw: unknown): RelayTurnMembers | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.ok !== 'number' || typeof row.total !== 'number') return undefined;
  if (!Number.isFinite(row.ok) || !Number.isFinite(row.total) || row.ok < 0 || row.total < 0) {
    return undefined;
  }
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
  return { ok: Math.floor(row.ok), total: Math.floor(row.total), updatedAt };
}

export function normalizeRelayTurn(raw: RelayTurnProbe | null | undefined): RelayTurnProbe | null {
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url) return null;
  const members = normalizeTurnMembers(raw.members);
  const localHint = raw.localHint === 'tun' ? ('tun' as const) : undefined;
  return {
    url: raw.url,
    probeOk: typeof raw.probeOk === 'boolean' ? raw.probeOk : null,
    ...(members ? { members } : {}),
    ...(localHint ? { localHint } : {}),
  };
}
