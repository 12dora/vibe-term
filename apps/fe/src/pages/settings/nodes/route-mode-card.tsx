// 设置 → 多节点互联：「延迟优化」三选一。乐观更新失败回滚并 toast。

import {
  type ApiClient,
  defaultApiClient,
  getMeshRouteMode,
  setMeshRouteMode,
} from '@vibeterm/api-client';
import {
  DEFAULT_MESH_ROUTE_MODE,
  MESH_ROUTE_MODES,
  type MeshRouteMode,
} from '@vibeterm/shared/net';
import { Cable, Gauge, Waypoints } from 'lucide-react';
import { useMemo } from 'react';
import {
  type MeshSettingApi,
  MeshSettingCard,
  MeshSettingChooser,
  type MeshSettingSpec,
  applyMeshSettingSelection,
} from './mesh-setting-card';

const SPEC: MeshSettingSpec<MeshRouteMode> = {
  testId: 'mesh-route-mode',
  i18nPrefix: 'settings.nodes.routeMode',
  values: MESH_ROUTE_MODES,
  icons: {
    auto: <Gauge className="size-4" />,
    direct: <Cable className="size-4" />,
    relay: <Waypoints className="size-4" />,
  },
  defaultValue: DEFAULT_MESH_ROUTE_MODE,
  columns: 3,
};

export interface RouteModeApi {
  get(): Promise<{ mode: MeshRouteMode }>;
  set(mode: MeshRouteMode): Promise<{ mode: MeshRouteMode }>;
}

export function routeModeApi(client: ApiClient = defaultApiClient): RouteModeApi {
  return {
    get: () => getMeshRouteMode(client),
    set: (mode) => setMeshRouteMode(mode, client),
  };
}

/** 乐观切到 next，失败回滚到 current 并交给 onError。同值不发请求。 */
export function applyRouteModeSelection(opts: {
  current: MeshRouteMode;
  next: MeshRouteMode;
  set: (mode: MeshRouteMode) => Promise<{ mode: MeshRouteMode }>;
  onOptimistic: (mode: MeshRouteMode) => void;
  onCommitted: (mode: MeshRouteMode) => void;
  onRollback: (mode: MeshRouteMode) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  return applyMeshSettingSelection({
    ...opts,
    set: (mode) => opts.set(mode).then((result) => result.mode),
  });
}

function valueApi(api: RouteModeApi): MeshSettingApi<MeshRouteMode> {
  return {
    get: () => api.get().then((result) => result.mode),
    set: (mode) => api.set(mode).then((result) => result.mode),
  };
}

export interface RouteModeCardProps {
  api?: RouteModeApi;
  client?: ApiClient;
}

export function RouteModeChooser({
  mode,
  disabled,
  onSelect,
}: {
  mode: MeshRouteMode;
  disabled: boolean;
  onSelect: (mode: MeshRouteMode) => void;
}) {
  return <MeshSettingChooser spec={SPEC} value={mode} disabled={disabled} onSelect={onSelect} />;
}

export function RouteModeCard({ api, client = defaultApiClient }: RouteModeCardProps) {
  const resolved = useMemo(() => valueApi(api ?? routeModeApi(client)), [api, client]);
  return <MeshSettingCard spec={SPEC} api={resolved} />;
}
