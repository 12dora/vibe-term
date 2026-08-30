import type { TunnelErrorCode } from '@tmex/shared';

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export function tunnelErrorFrom(error: unknown): { code: TunnelErrorCode; message: string } {
  if (error instanceof TunnelError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function tunnelHttpStatus(code: TunnelErrorCode): number {
  switch (code) {
    case 'busy':
    case 'tunnel_exists':
    case 'auth_required':
      return 409;
    case 'invalid_request':
    case 'invalid_hostname':
    case 'not_configured':
    case 'unsupported_platform':
    case 'binary_missing':
    case 'not_logged_in':
      return 400;
    default:
      return 500;
  }
}
