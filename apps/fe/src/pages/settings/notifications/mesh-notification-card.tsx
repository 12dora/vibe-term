// 设置页「通知」标签的「多节点通知」卡片。
//
// 开关声明本机为汇聚点：打开后其它节点的事件会转发过来，经本机的 webhook / Telegram /
// 微信 / 浏览器通道发出。声明本身在 mesh 内广播，所以状态行列的是**全网**的汇聚节点，
// 不只是本机。网关不支持该端点（老节点）或本机未联网互联时整块不渲染。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MeshNotificationForwardQueueStats,
  MeshNotificationSink,
  MeshNotificationState,
} from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Skeleton } from '@tmex/ui/skeleton';
import { Switch } from '@tmex/ui/switch';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { SETTINGS_STALE_MS } from '../data-prefetch';
import {
  fetchMeshNotificationState,
  meshNotificationQueryKey,
  updateMeshNotificationState,
} from './mesh-api';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 汇聚节点名；离线的加尾注。 */
export function meshSinkLabel(sink: MeshNotificationSink, t: Translate): string {
  return sink.online
    ? sink.name
    : t('settings.notifications.mesh.offlineName', { name: sink.name });
}

/** 状态行：有汇聚节点就逐个点名，没有就说明各节点只通知自身。 */
export function meshSinkSummary(sinks: readonly MeshNotificationSink[], t: Translate): string {
  if (sinks.length === 0) return t('settings.notifications.mesh.empty');
  const names = sinks
    .map((sink) => meshSinkLabel(sink, t))
    .join(t('settings.notifications.mesh.separator'));
  return t('settings.notifications.mesh.sinks', { names });
}

/** 转发队列只在真有积压/丢弃时才占一行。 */
export function meshQueueNote(
  queue: MeshNotificationForwardQueueStats | undefined,
  t: Translate
): string | null {
  if (!queue) return null;
  if (queue.pending <= 0 && queue.dropped <= 0) return null;
  return t('settings.notifications.mesh.queue', {
    pending: queue.pending,
    dropped: queue.dropped,
  });
}

export interface MeshNotificationCardBodyProps {
  state: MeshNotificationState;
  saving: boolean;
  error: string | null;
  onEnabledChange: (enabled: boolean) => void;
}

/** 卡片正文。单独导出，供静态渲染的单测直接断言。 */
export function MeshNotificationCardBody({
  state,
  saving,
  error,
  onEnabledChange,
}: MeshNotificationCardBodyProps) {
  const { t } = useTranslation();
  const queueNote = meshQueueNote(state.forwardQueue, t);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <label className="block text-sm font-medium" htmlFor="settings-mesh-notify-switch">
            {t('settings.notifications.mesh.switchLabel')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings.notifications.mesh.switchHint')}
          </p>
        </div>
        <Switch
          id="settings-mesh-notify-switch"
          checked={state.selfEnabled}
          disabled={saving}
          onCheckedChange={(next) => onEnabledChange(next === true)}
          data-testid="settings-mesh-notify-switch"
        />
      </div>

      <p className="text-xs text-muted-foreground" data-testid="settings-mesh-notify-sinks">
        {meshSinkSummary(state.sinks, t)}
      </p>

      {queueNote && (
        <p className="text-[11px] text-muted-foreground" data-testid="settings-mesh-notify-queue">
          {queueNote}
        </p>
      )}

      {error && (
        <Notice tone="error" testId="settings-mesh-notify-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

function MeshNotificationCardShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="settings-mesh-notify-card">
      <CardHeader>
        <CardTitle>{t('settings.notifications.mesh.title')}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function MeshNotificationCard() {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: meshNotificationQueryKey,
    queryFn: ({ signal }) => fetchMeshNotificationState(apiClient, signal),
    staleTime: SETTINGS_STALE_MS,
  });

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => updateMeshNotificationState(apiClient, enabled),
    onSuccess: (next) => {
      queryClient.setQueryData(meshNotificationQueryKey, next);
      void queryClient.invalidateQueries({ queryKey: meshNotificationQueryKey });
    },
  });

  if (query.isPending) {
    return (
      <MeshNotificationCardShell>
        <Skeleton className="h-10 w-full" />
      </MeshNotificationCardShell>
    );
  }

  // 首次加载就失败：不知道支不支持，给一条明确的失败提示而不是静默消失。
  if (!query.data) {
    return (
      <MeshNotificationCardShell>
        <Notice tone="error" testId="settings-mesh-notify-load-error">
          {t('settings.notifications.mesh.loadFailed', { message: errorMessage(query.error, t) })}
        </Notice>
      </MeshNotificationCardShell>
    );
  }

  if (!query.data.supported) return null;

  return (
    <MeshNotificationCardShell>
      <MeshNotificationCardBody
        state={query.data}
        saving={mutation.isPending}
        error={
          mutation.error
            ? t('settings.notifications.mesh.saveFailed', {
                message: errorMessage(mutation.error, t),
              })
            : null
        }
        onEnabledChange={(enabled) => mutation.mutate(enabled)}
      />
    </MeshNotificationCardShell>
  );
}

function errorMessage(error: unknown, t: Translate): string {
  return error instanceof Error && error.message ? error.message : t('common.error');
}
