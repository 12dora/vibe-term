import type { ExecSession } from './session';

const sessions = new Map<string, ExecSession>();
let pendingOpens = 0;

export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function reserveSessionSlot(max: number): boolean {
  if (sessions.size + pendingOpens >= max) return false;
  pendingOpens += 1;
  return true;
}

export function releaseSessionSlot(): void {
  pendingOpens = Math.max(0, pendingOpens - 1);
}

export function commitSession(session: ExecSession): void {
  releaseSessionSlot();
  sessions.set(session.id, session);
}

export function removeSession(id: string): void {
  sessions.delete(id);
}

export function getSession(id: string): ExecSession | undefined {
  return sessions.get(id);
}

export function liveSessionCount(): number {
  return sessions.size;
}

function terminateWhere(match: (session: ExecSession) => boolean, reason: string): void {
  for (const session of [...sessions.values()]) {
    if (match(session)) session.terminate(4401, reason);
  }
}

export function closeExecSessionsForToken(tokenId: string): void {
  terminateWhere((session) => session.tokenId === tokenId, 'token revoked');
}

export function closeExecSessionsForUser(uid: string): void {
  terminateWhere((session) => session.uid === uid, 'user closed');
}

export function resetExecRegistryForTests(): void {
  for (const session of [...sessions.values()]) session.terminate(1000, 'reset');
  sessions.clear();
  pendingOpens = 0;
}
