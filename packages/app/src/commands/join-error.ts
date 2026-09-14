export const NODE_REVOKED_REJOIN_ERROR =
  'this node identity was revoked; use a fresh identity (mesh reset / re-init)';

export type JoinErrorCode =
  | 'invalid_token'
  | 'invalid_url'
  | 'node_revoked'
  | 'node_exists'
  | 'relay_unreachable'
  | 'join_failed'
  | 'totp_required'
  | 'totp_invalid';

export class JoinError extends Error {
  readonly code: JoinErrorCode;

  constructor(code: JoinErrorCode, message: string) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
  }
}

export function joinErrorHttpStatus(code: string): number {
  if (code === 'node_revoked' || code === 'node_exists') return 409;
  if (code === 'relay_unreachable') return 502;
  return 400;
}
