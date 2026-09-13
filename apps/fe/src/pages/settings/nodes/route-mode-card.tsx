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
import { Card, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { Cable, Gauge, Waypoints } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChoiceCard } from '../remote-access/choice-card';

const I18N = 'settings.nodes.routeMode';
const MODE_ICON: Record<MeshRouteMode, ReactNode> = {
  auto: <Gauge className="size-4" />,
  direct: <Cable className="size-4" />,
  relay: <Waypoints className="size-4" />,
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
export async function applyRouteModeSelection(opts: {
  current: MeshRouteMode;
  next: MeshRouteMode;
  set: (mode: MeshRouteMode) => Promise<{ mode: MeshRouteMode }>;
  onOptimistic: (mode: MeshRouteMode) => void;
  onCommitted: (mode: MeshRouteMode) => void;
  onRollback: (mode: MeshRouteMode) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  if (opts.next === opts.current) return;
  opts.onOptimistic(opts.next);
  try {
    const result = await opts.set(opts.next);
    opts.onCommitted(result.mode);
  } catch (error) {
    opts.onRollback(opts.current);
    opts.onError(error);
  }
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
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-3"
      role="radiogroup"
      aria-label={t(`${I18N}.title`)}
      data-testid="mesh-route-mode-chooser"
    >
      {MESH_ROUTE_MODES.map((value) => (
        <ChoiceCard
          key={value}
          group="mesh-route-mode"
          value={value}
          icon={MODE_ICON[value]}
          selected={mode === value}
          disabled={disabled}
          onSelect={onSelect}
          testidPrefix="mesh-route-mode"
          i18nPrefix={I18N}
        />
      ))}
    </div>
  );
}

export function RouteModeCard({ api, client = defaultApiClient }: RouteModeCardProps) {
  const { t } = useTranslation();
  const resolved = useMemo(() => api ?? routeModeApi(client), [api, client]);
  const [mode, setMode] = useState<MeshRouteMode>(DEFAULT_MESH_ROUTE_MODE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolved
      .get()
      .then((payload) => {
        if (cancelled) return;
        setMode(payload.mode);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoaded(true);
        toast.error(
          t(`${I18N}.loadFailed`, {
            message: error instanceof Error ? error.message : String(error),
          })
        );
      });
    return () => {
      cancelled = true;
    };
  }, [resolved, t]);

  const onSelect = useCallback(
    (next: MeshRouteMode) => {
      if (saving) return;
      setSaving(true);
      void applyRouteModeSelection({
        current: mode,
        next,
        set: resolved.set,
        onOptimistic: setMode,
        onCommitted: setMode,
        onRollback: setMode,
        onError: (error) => {
          toast.error(
            t(`${I18N}.saveFailed`, {
              message: error instanceof Error ? error.message : String(error),
            })
          );
        },
      }).finally(() => setSaving(false));
    },
    [mode, resolved, saving, t]
  );

  return (
    <Card data-testid="mesh-route-mode-card">
      <CardHeader>
        <CardTitle>{t(`${I18N}.title`)}</CardTitle>
      </CardHeader>
      <CardContent>
        {loaded ? (
          <RouteModeChooser mode={mode} disabled={saving} onSelect={onSelect} />
        ) : (
          <Skeleton className="h-24 w-full" data-testid="mesh-route-mode-skeleton" />
        )}
      </CardContent>
    </Card>
  );
}
