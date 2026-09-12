import { GATEWAY_CAPABILITIES } from '@vibeterm/shared';

/** 与浏览器 `direct-hello-connection.ts` 同形：旧壳忽略未知能力串。 */
export const CONNECTION_ID_CAPABILITY_PREFIX = 'connection-id:';

export function formatConnectionIdCapability(connectionId: string): string {
  return `${CONNECTION_ID_CAPABILITY_PREFIX}${connectionId}`;
}

export function helloS2CCapabilities(connectionId: string | null | undefined): string[] {
  if (!connectionId) return [...GATEWAY_CAPABILITIES];
  return [...GATEWAY_CAPABILITIES, formatConnectionIdCapability(connectionId)];
}
