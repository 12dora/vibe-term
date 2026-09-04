import type { RelayCtlMessage, RelayQuota } from '@tmex/shared/relay';

export function relayQuotaCtl(
  quota: RelayQuota,
  currentNodes: number
): Extract<RelayCtlMessage, { t: 'relay.quota' }> {
  return { t: 'relay.quota', ...quota, currentNodes };
}
