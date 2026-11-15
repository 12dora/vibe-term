import { errorMessage } from '@vibeterm/shared';
import type { TunnelErrorCode } from '@vibeterm/shared';

export const HOST_ENV_MESSAGE = 'Host environment is not managed by vibeterm-cli';
export const EXPOSURE_ACK_MESSAGE =
  'This instance has no sign-in and no Cloudflare Access protection; confirm public exposure explicitly';
export const EXTERNAL_MANAGED_MESSAGE = 'managed by the system service';

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
    message: errorMessage(error),
  };
}

const TUNNEL_HTTP_STATUS: Partial<Record<TunnelErrorCode, number>> = {
  busy: 409,
  tunnel_exists: 409,
  auth_required: 409,
  exposure_ack_required: 409,
  invalid_request: 400,
  invalid_hostname: 400,
  not_configured: 400,
  unsupported_platform: 400,
  binary_missing: 400,
  binary_checksum_mismatch: 400,
  not_logged_in: 400,
  access_api_failed: 400,
  connector_down: 503,
};

export function tunnelHttpStatus(code: TunnelErrorCode, override?: number): number {
  if (override) return override;
  return TUNNEL_HTTP_STATUS[code] ?? 500;
}
