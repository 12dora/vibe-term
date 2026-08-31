// 聚合三路本机信息拼出手机可用的地址：隧道状态（公网入口）、auth mode（Hub 公开地址）、
// `/api/system/addresses`（监听地址 + 局域网 IP）。三路都问浏览器直连的这台机器。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { TUNNEL_STATUS_QUERY_KEY, fetchSelfTunnelStatus } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import type { AccessAddressesResponse } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { type AccessAddress, buildAccessAddresses, showLoopbackHint } from './access-addresses';

export const ACCESS_ADDRESSES_QUERY_KEY = ['system-access-addresses'] as const;

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function useAccessAddresses(): { list: AccessAddress[]; loopbackHint: boolean } {
  const { apiClient } = useRuntime();
  const { mode } = useSharedAuthMode();
  const tunnel = useQuery({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: fetchSelfTunnelStatus,
    staleTime: 10_000,
    retry: false,
  });
  const addresses = useQuery({
    queryKey: ACCESS_ADDRESSES_QUERY_KEY,
    queryFn: async (): Promise<AccessAddressesResponse> => {
      const res = await apiClient.fetch('/api/system/addresses');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AccessAddressesResponse;
    },
    staleTime: 60_000,
    retry: false,
  });
  const input = {
    origin: currentOrigin(),
    tunnel: tunnel.data ?? null,
    hubPublicUrl: mode?.hubPublicUrl ?? null,
    addresses: addresses.data ?? null,
  };
  const list = buildAccessAddresses(input);
  return { list, loopbackHint: showLoopbackHint(list, input) };
}
