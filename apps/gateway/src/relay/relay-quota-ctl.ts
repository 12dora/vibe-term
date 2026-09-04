import type { RelayCtlMessage, RelayQuota, RelayQuotaUsage } from '@tmex/shared/relay';

export type { RelayQuotaUsage };

export function relayQuotaUsageFingerprint(usage: RelayQuotaUsage): string {
  return [
    usage.currentNodes,
    usage.currentStreams,
    usage.bytesInPerSec,
    usage.bytesOutPerSec,
    usage.bandwidthBytesPerSec ?? 0,
  ].join('|');
}

export function relayQuotaCtl(
  quota: RelayQuota,
  currentNodes: number,
  usage?: RelayQuotaUsage
): Extract<RelayCtlMessage, { t: 'relay.quota' }> {
  const { usage: _ignored, ...limits } = quota;
  return {
    t: 'relay.quota',
    ...limits,
    currentNodes,
    ...(usage ? { usage } : {}),
  };
}
