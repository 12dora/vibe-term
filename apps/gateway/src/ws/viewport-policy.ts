export interface ViewportClaim {
  paneId: string;
  cols: number;
  rows: number;
  visible: boolean;
  at: number;
}

export interface ViewportClaimRecord {
  sessionId: string;
  claim: ViewportClaim;
}

export interface ViewportWinner {
  sessionId: string;
  claim: ViewportClaim;
}

export function viewportClaimKey(deviceId: string, windowId: string): string {
  return `${deviceId}/${windowId}`;
}

export function parseViewportClaimKey(key: string): { deviceId: string; windowId: string } {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) {
    return { deviceId: key, windowId: '' };
  }
  return { deviceId: key.slice(0, slash), windowId: key.slice(slash + 1) };
}

function area(claim: ViewportClaim): number {
  return claim.cols * claim.rows;
}

export function resolveWinner(claims: Iterable<ViewportClaimRecord>): ViewportWinner | null {
  let winner: ViewportWinner | null = null;
  for (const entry of claims) {
    if (!entry.claim.visible) continue;
    if (!winner) {
      winner = entry;
      continue;
    }
    const nextArea = area(entry.claim);
    const winnerArea = area(winner.claim);
    if (nextArea !== winnerArea) {
      if (nextArea > winnerArea) winner = entry;
      continue;
    }
    if (entry.claim.cols !== winner.claim.cols) {
      if (entry.claim.cols > winner.claim.cols) winner = entry;
      continue;
    }
    if (entry.claim.rows !== winner.claim.rows) {
      if (entry.claim.rows > winner.claim.rows) winner = entry;
      continue;
    }
    if (entry.sessionId < winner.sessionId) winner = entry;
  }
  return winner;
}

export function takeViewportClaimKeys(
  claims: Map<string, ViewportClaim>,
  deviceId?: string
): Array<{ key: string; deviceId: string; windowId: string }> {
  const affected: Array<{ key: string; deviceId: string; windowId: string }> = [];
  for (const key of claims.keys()) {
    const parsed = parseViewportClaimKey(key);
    if (deviceId && parsed.deviceId !== deviceId) continue;
    affected.push({ key, ...parsed });
  }
  for (const item of affected) {
    claims.delete(item.key);
  }
  return affected;
}
