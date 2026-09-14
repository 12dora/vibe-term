export const NODE_REVOKED_REJOIN_ERROR =
  'this node identity was revoked; use a fresh identity (mesh reset / re-init)';

export type JoinErrorCode =
  | 'invalid_token'
  | 'invalid_url'
  | 'node_revoked'
  | 'relay_unreachable'
  | 'join_failed';

export class JoinError extends Error {
  readonly code: JoinErrorCode;

  constructor(code: JoinErrorCode, message: string) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
  }
}
