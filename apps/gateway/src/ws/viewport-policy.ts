/** 上一次真正发给该会话的策略：再来任何声明时若与之不同就重发，丢一条也能靠下一次声明补回。 */
export interface ViewportSentPolicy {
  paneId: string;
  owner: boolean;
  cols: number;
  rows: number;
}

export interface ViewportClaim {
  paneId: string;
  cols: number;
  rows: number;
  visible: boolean;
  at: number;
  sentPolicy?: ViewportSentPolicy;
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

export function collectWindowClaims(
  claimants: Iterable<{ id: string; viewportClaims: Map<string, ViewportClaim> }>,
  key: string
): ViewportClaimRecord[] {
  const records: ViewportClaimRecord[] = [];
  for (const session of claimants) {
    const claim = session.viewportClaims.get(key);
    if (!claim) continue;
    records.push({ sessionId: session.id, claim });
  }
  return records;
}

export function reconcileViewportClaims(
  claimants: Iterable<{ viewportClaims: Map<string, ViewportClaim> }>,
  key: string,
  windowId: string,
  paneWindowId: (paneId: string) => string | null
): string[] {
  const { deviceId } = parseViewportClaimKey(key);
  const moved = new Set<string>();
  for (const session of claimants) {
    const claim = session.viewportClaims.get(key);
    if (!claim) continue;
    const current = paneWindowId(claim.paneId);
    if (current === windowId) continue;
    session.viewportClaims.delete(key);
    if (!current) continue;
    session.viewportClaims.set(viewportClaimKey(deviceId, current), claim);
    moved.add(current);
  }
  return [...moved];
}

export function rebindAllViewportClaims(
  claimants: Iterable<{ viewportClaims: Map<string, ViewportClaim> }>,
  deviceId: string,
  paneWindowId: (paneId: string) => string | null
): string[] {
  const affected = new Set<string>();
  for (const session of claimants) {
    for (const [key, claim] of [...session.viewportClaims]) {
      const parsed = parseViewportClaimKey(key);
      if (parsed.deviceId !== deviceId) continue;
      const current = paneWindowId(claim.paneId);
      if (current === parsed.windowId) continue;
      session.viewportClaims.delete(key);
      affected.add(parsed.windowId);
      if (!current) continue;
      session.viewportClaims.set(viewportClaimKey(deviceId, current), claim);
      affected.add(current);
    }
  }
  return [...affected];
}

export function applyWinnerGeometry(
  winner: ViewportWinner | null,
  lastApplied: { cols: number; rows: number } | undefined
): { paneId: string; cols: number; rows: number; force: boolean } | null {
  if (!winner) return null;
  const sameGeometry =
    lastApplied != null &&
    lastApplied.cols === winner.claim.cols &&
    lastApplied.rows === winner.claim.rows;
  if (sameGeometry) return null;
  return {
    paneId: winner.claim.paneId,
    cols: winner.claim.cols,
    rows: winner.claim.rows,
    force: lastApplied != null,
  };
}

export function notifyClaimants<
  T extends { id: string; viewportClaims: Map<string, ViewportClaim> },
>(
  claimants: Iterable<T>,
  key: string,
  shouldBroadcast: boolean,
  notifyFirst: T | undefined,
  policyFor: (session: T, claim: ViewportClaim) => Omit<ViewportSentPolicy, 'paneId'>,
  send: (session: T, claim: ViewportClaim) => void
): void {
  for (const session of claimants) {
    const claim = session.viewportClaims.get(key);
    if (!claim) continue;
    const next = { ...policyFor(session, claim), paneId: claim.paneId };
    const prev = claim.sentPolicy;
    const changed =
      !prev ||
      prev.paneId !== next.paneId ||
      prev.owner !== next.owner ||
      prev.cols !== next.cols ||
      prev.rows !== next.rows;
    if (!shouldBroadcast && session !== notifyFirst && !changed) continue;
    claim.sentPolicy = next;
    send(session, claim);
  }
}
