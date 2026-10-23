// 设置 → 多节点互联：「节点连接代理」二选一（直连 / 系统代理）。乐观更新失败回滚并 toast。

import { type ApiClient, defaultApiClient, getMeshProxy, setMeshProxy } from '@vibeterm/api-client';
import {
  DEFAULT_MESH_PROXY_MODE,
  MESH_PROXY_MODES,
  type MeshProxyMode,
} from '@vibeterm/shared/net';
import { Cable, Network } from 'lucide-react';
import { useMemo } from 'react';
import { type MeshSettingApi, MeshSettingCard, type MeshSettingSpec } from './mesh-setting-card';

export const MESH_PROXY_SPEC: MeshSettingSpec<MeshProxyMode> = {
  testId: 'mesh-proxy',
  i18nPrefix: 'settings.nodes.meshProxy',
  values: MESH_PROXY_MODES,
  icons: {
    direct: <Cable className="size-4" />,
    system: <Network className="size-4" />,
  },
  defaultValue: DEFAULT_MESH_PROXY_MODE,
  columns: 2,
};

export function meshProxyApi(client: ApiClient = defaultApiClient): MeshSettingApi<MeshProxyMode> {
  return {
    get: () => getMeshProxy(client).then((result) => result.meshProxy),
    set: (mode) => setMeshProxy(mode, client).then((result) => result.meshProxy),
  };
}

export interface MeshProxyCardProps {
  api?: MeshSettingApi<MeshProxyMode>;
  client?: ApiClient;
}

export function MeshProxyCard({ api, client = defaultApiClient }: MeshProxyCardProps) {
  const resolved = useMemo(() => api ?? meshProxyApi(client), [api, client]);
  return <MeshSettingCard spec={MESH_PROXY_SPEC} api={resolved} />;
}
