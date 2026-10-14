import type { ExecSession } from './session';
import type { ExecSessionRef } from './transport-types';

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

export type ExecPrincipal = {
  uid: string | null;
  tokenId: string | null;
  sessionRef: ExecSessionRef | null;
};

/** 尚未（或不再）挂会话的在途凭证持有者：等待首个 HELLO 的通道连接、旧版 POST /api/exec 的运行。 */
export interface ExecConnectionHandle extends ExecPrincipal {
  terminate(code: number, reason: string): void;
}

const connections = new Set<ExecConnectionHandle>();

export function registerExecConnection(handle: ExecConnectionHandle): () => void {
  connections.add(handle);
  return () => {
    connections.delete(handle);
  };
}

function terminateWhere(match: (principal: ExecPrincipal) => boolean, reason: string): void {
  for (const session of [...sessions.values()]) {
    if (match(session)) session.terminate(4401, reason);
  }
  for (const handle of [...connections]) {
    if (match(handle)) handle.terminate(4401, reason);
  }
}

export function closeExecSessionsForToken(tokenId: string): void {
  terminateWhere((principal) => principal.tokenId === tokenId, 'token revoked');
}

/** 令牌已失效（撤销 / 过期 / 行被级联删除）的 exec 会话与连接一并终止；`isActive` 对每个令牌只问一次。 */
export function closeExecSessionsWithInactiveToken(isActive: (tokenId: string) => boolean): void {
  const verdicts = new Map<string, boolean>();
  terminateWhere((principal) => {
    const id = principal.tokenId;
    if (id === null) return false;
    if (!verdicts.has(id)) verdicts.set(id, isActive(id));
    return verdicts.get(id) === false;
  }, 'token revoked');
}

export function closeExecSessionsForSid(sid: string): void {
  terminateWhere((principal) => principal.sessionRef?.sid === sid, 'session revoked');
}

/** 依附的节点会话已失效（过期 / 撤销 / 行被删）的 exec 会话与连接一并终止；`isValid` 对每个会话只问一次。 */
export function closeExecSessionsWithInvalidSession(
  isValid: (ref: ExecSessionRef) => boolean
): void {
  const verdicts = new Map<string, boolean>();
  terminateWhere((principal) => {
    const ref = principal.sessionRef;
    if (!ref) return false;
    const key = `${ref.viaNodeId}\0${ref.sid}`;
    if (!verdicts.has(key)) verdicts.set(key, isValid(ref));
    return verdicts.get(key) === false;
  }, 'session revoked');
}

export function closeExecSessionsForUser(uid: string): void {
  terminateWhere((principal) => principal.uid === uid, 'user closed');
}

export function resetExecRegistryForTests(): void {
  for (const session of [...sessions.values()]) session.terminate(1000, 'reset');
  for (const handle of [...connections]) handle.terminate(1000, 'reset');
  sessions.clear();
  connections.clear();
  pendingOpens = 0;
}
