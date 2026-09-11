import { GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1, wsBorsh } from '@vibeterm/shared';
import type { GatewayTransportCommand } from './transport-types';

export function buildScreenIntentCommand(
  command: Extract<GatewayTransportCommand, { type: 'request-pane-screen' }>,
  capabilities: readonly string[]
): wsBorsh.CanonicalCommand | null {
  if (!capabilities.includes(GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1)) return null;
  return {
    RequestScreenIntent: {
      requestId: command.requestId,
      deviceId: command.deviceId,
      windowId: null,
      paneId: command.paneId,
      byteLimit: command.byteLimit,
    },
  };
}
