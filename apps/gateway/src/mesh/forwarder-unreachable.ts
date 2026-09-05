import type { NodeUnreachableReason } from '@tmex/shared';
import { LinkError } from '@tmex/shared/link';
import { jsonError } from './session-middleware';
import { NodeUnreachableError, PeerHandshakeError } from './types';

const RELAY_RESET_REASONS = new Set<string>([
  'self-target',
  'unknown-target',
  'offline',
  'quota-streams',
  'open-failed',
]);

/**
 * 链路建起来又断了：中继复位、顶号、上行切换、对端下线。与「压根没有链路」（`no_link`）
 * 分开——前者重试通常能成，推包据此走续传重试而不是直接判死。
 */
const LINK_LOST_REASONS = new Set<string>([
  'stream-aborted',
  'link-closed',
  'replaced',
  'relay-replaced',
  'stopped',
]);

/** token → reason 的直查表；同义写法都收在这里，判定函数只留兜底分支。 */
const TOKEN_REASONS = new Map<string, NodeUnreachableReason>([
  ['not admitted', 'not_admitted'],
  ['not_admitted', 'not_admitted'],
  ['revoked', 'not_admitted'],
  ['timeout', 'timeout'],
  ['connect-timeout', 'timeout'],
  ['handshake-timeout', 'timeout'],
  ['handshake_failed', 'handshake_failed'],
  ['handshake-failed', 'handshake_failed'],
  ...[...LINK_LOST_REASONS].map((token): [string, NodeUnreachableReason] => [token, 'link_lost']),
]);

export function classifyUnreachableReason(
  aborted: boolean,
  lastError: unknown
): NodeUnreachableReason {
  if (aborted) return 'timeout';
  if (lastError !== undefined) return safeUnreachableReason(lastError);
  return 'no_link';
}

export function safeUnreachableReason(err: unknown): NodeUnreachableReason {
  if (err instanceof PeerHandshakeError) {
    return err.code === 'timeout' ? 'timeout' : 'handshake_failed';
  }
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'timeout';
  }
  const token = unreachableToken(err);
  if (RELAY_RESET_REASONS.has(token)) {
    return `relay_reset:${token}` as NodeUnreachableReason;
  }
  if (token.startsWith('relay-rst')) return 'link_lost';
  return TOKEN_REASONS.get(token) ?? 'no_link';
}

function unreachableToken(err: unknown): string {
  if (err instanceof LinkError && err.code === 'rst') return err.message.trim();
  if (err instanceof NodeUnreachableError) return err.message.trim();
  if (err instanceof Error) return err.message.trim();
  return '';
}

export function nodeUnreachableResponse(
  nodeId: string,
  aborted: boolean,
  lastError?: unknown,
  extra?: Record<string, unknown>
): Response {
  return jsonError('NODE_UNREACHABLE', 503, {
    nodeId,
    reason: classifyUnreachableReason(aborted, lastError),
    ...extra,
  });
}
