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
  if (token === 'not admitted' || token === 'not_admitted' || token === 'revoked') {
    return 'not_admitted';
  }
  if (token === 'timeout' || token === 'connect-timeout' || token === 'handshake-timeout') {
    return 'timeout';
  }
  if (token === 'handshake_failed' || token === 'handshake-failed') {
    return 'handshake_failed';
  }
  return 'no_link';
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
