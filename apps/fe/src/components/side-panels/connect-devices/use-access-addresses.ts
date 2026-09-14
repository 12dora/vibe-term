// 聚合本机信息拼出手机可用的地址：隧道状态（公网入口）、
// 中继链路，以及 `/api/system/addresses`（监听地址 + 局域网候选 + 中继入口）。
// 全部问浏览器直连的这台机器。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import { TUNNEL_STATUS_QUERY_KEY, fetchSelfTunnelStatus } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import type { AccessAddressesResponse } from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import {
  ADDRESSES_RELAY_POLL_MS,
  type AccessAddress,
  buildAccessAddresses,
  shouldRefetchAddresses,
  showLoopbackHint,
} from './access-addresses';

export const ACCESS_ADDRESSES_QUERY_KEY = ['system-access-addresses'] as const;

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function useAccessAddresses(): { list: AccessAddress[]; loopbackHint: boolean } {
  const { apiClient } = useRuntime();
  const { meshEnabled } = useSharedAuthMode();
  const relay = useMeshRelay({ enabled: meshEnabled });
  const tunnel = useQuery({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: fetchSelfTunnelStatus,
    staleTime: 10_000,
    retry: false,
  });
  const relayMode = relay.relayMode;
  const addresses = useQuery({
    queryKey: ACCESS_ADDRESSES_QUERY_KEY,
    queryFn: async (): Promise<AccessAddressesResponse> => {
      const res = await apiClient.fetch('/api/system/addresses');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AccessAddressesResponse;
    },
    staleTime: 60_000,
    retry: false,
    // `dataUpdateCount` 首次成功后为 1，减一即已补刷次数。
    refetchInterval: (query) =>
      shouldRefetchAddresses({
        relayMode,
        addresses: query.state.data ?? null,
        attempts: Math.max(0, query.state.dataUpdateCount - 1),
      })
        ? ADDRESSES_RELAY_POLL_MS
        : false,
  });
  const input = {
    origin: currentOrigin(),
    tunnel: tunnel.data ?? null,
    relayMode,
    addresses: addresses.data ?? null,
  };
  const list = buildAccessAddresses(input);
  return { list, loopbackHint: showLoopbackHint(list, input) };
}
