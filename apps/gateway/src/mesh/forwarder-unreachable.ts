import type { NodeUnreachableReason } from '@vibeterm/shared';
import { LinkError } from '@vibeterm/shared/link';
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
  // 对端在接受流时就拒绝这条传输，请求还没被处理。
  'pending-measure',
  'stale-link',
  'parked',
]);

/** 开流即拒、对端还没读 body。POST 重放一次是安全的；半截上传不是。 */
const PRE_DISPATCH_REFUSAL = new Set<string>(['pending-measure', 'stale-link', 'parked']);

/** token → reason 的直查表；同义写法都收在这里，判定函数只留兜底分支。 */
const TOKEN_REASONS = new Map<string, NodeUnreachableReason>([
  ['not admitted', 'not_admitted'],
  ['not_admitted', 'not_admitted'],
  ['revoked', 'not_admitted'],
  ['timeout', 'timeout'],
  ['connect-timeout', 'timeout'],
  ['handshake-timeout', 'timeout'],
  ['upload-stall', 'timeout'],
  ['handshake_failed', 'handshake_failed'],
  ['handshake-failed', 'handshake_failed'],
  ...[...LINK_LOST_REASONS].map((token): [string, NodeUnreachableReason] => [token, 'link_lost']),
]);

const DEADLINE_TOKENS = new Set<string>([
  'timeout',
  'connect-timeout',
  'handshake-timeout',
  'upload-stall',
  'http head timeout',
]);

/**
 * `obtainedLink`：这次失败发生在 `getLink` 已经返回之后。
 * 有链路时，截止/中止是 `timeout`，其余落在白名单外的原因是 `link_lost`（短退避）。
 * 没有链路时仍走 token 表，未知原因保持 `no_link`（长退避）。
 */
export function classifyUnreachableReason(
  aborted: boolean,
  lastError: unknown,
  obtainedLink = false
): NodeUnreachableReason {
  if (aborted) return 'timeout';
  if (lastError === undefined) return obtainedLink ? 'link_lost' : 'no_link';
  if (obtainedLink && isDeadlineFailure(lastError)) return 'timeout';
  const mapped = safeUnreachableReason(lastError);
  if (obtainedLink && mapped === 'no_link') return 'link_lost';
  return mapped;
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

export function isPreDispatchTransportRefusal(err: unknown): boolean {
  return PRE_DISPATCH_REFUSAL.has(unreachableToken(err));
}

export function isPendingMeasureRefusal(err: unknown): boolean {
  return unreachableToken(err) === 'pending-measure';
}

function unreachableToken(err: unknown): string {
  if (err instanceof LinkError && err.code === 'rst') return err.message.trim();
  if (err instanceof NodeUnreachableError) return err.message.trim();
  if (err instanceof Error) return err.message.trim();
  return '';
}

function isDeadlineFailure(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  return DEADLINE_TOKENS.has(unreachableToken(err));
}

export function nodeUnreachableResponse(
  nodeId: string,
  aborted: boolean,
  lastError?: unknown,
  extra?: Record<string, unknown>,
  obtainedLink = false
): Response {
  return jsonError('NODE_UNREACHABLE', 503, {
    nodeId,
    reason: classifyUnreachableReason(aborted, lastError, obtainedLink),
    ...extra,
  });
}
