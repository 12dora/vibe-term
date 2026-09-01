import type { TunnelErrorCode } from '@tmex/shared';

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string,
    readonly httpStatusOverride?: number
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

export function tunnelHttpStatus(code: TunnelErrorCode, override?: number): number {
  if (override) return override;
  switch (code) {
    case 'busy':
    case 'tunnel_exists':
    case 'auth_required':
    case 'exposure_ack_required':
      return 409;
    case 'invalid_request':
    case 'invalid_hostname':
    case 'not_configured':
    case 'unsupported_platform':
    case 'binary_missing':
    case 'not_logged_in':
    case 'access_api_failed':
      return 400;
    case 'connector_down':
      return 503;
    default:
      return 500;
  }
}
