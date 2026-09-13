// 设置页「通知」标签的「多节点通知」卡片。
//
// 开关声明本机为汇聚点：打开后其它节点的事件会转发过来，经本机的 webhook / Telegram /
// 微信 / 浏览器通道发出。声明是一条用户签名的 `notification-sink` 密钥日志记录（全网复制），
// 所以状态行列的是**全网**的汇聚节点，不只是本机；翻转开关要当场确认一次密码或通行密钥。
// 网关不支持该端点（老节点）或本机未联网互联时整块不渲染。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMeshNotificationState, meshNotificationQueryKey } from '@vibeterm/api-client';
import type {
  MeshNotificationForwardQueueStats,
  MeshNotificationSink,
  MeshNotificationState,
} from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import { Card, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { Switch } from '@vibeterm/ui/switch';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { MeshSinkError, meshSinkErrorText } from './mesh-sink-toggle';
import { useMeshSinkToggle } from './use-mesh-sink-toggle';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 汇聚声明在 mesh 里广播，队列计数则一直在动——两者都不经设置广播（`SETTINGS_EVENT`）通知
 * 浏览器，光靠设置页那份 `staleTime`（30 s）这张卡会一直停在打开那一刻的快照上。
 * 挂着就轮询；`staleTime` 跟着降到同一个值，否则窗口失焦期间轮询暂停、回来时数据仍被判「新鲜」，
 * 焦点重取形同虚设。
 */
export const MESH_NOTIFICATION_REFETCH_MS = 10_000;

export const meshNotificationRefreshOptions = {
  staleTime: MESH_NOTIFICATION_REFETCH_MS,
  refetchInterval: MESH_NOTIFICATION_REFETCH_MS,
  refetchOnWindowFocus: true,
} as const;

/** 节点表里会影响这张卡的部分：汇聚节点名与在线态都从这里来。 */
export function meshNodesSignature(
  nodes: readonly { id: string; name: string; online?: boolean }[]
): string {
  return nodes.map((node) => `${node.id}:${node.name}:${node.online === true ? 1 : 0}`).join('|');
}

/** 节点表一变（改名 / 上下线 / 增删）就把汇聚状态重取一次。 */
function useInvalidateOnMeshNodesChange(invalidate: () => void): void {
  const signature = useRef(meshNodesSignature(getMeshNodesState().nodes));
  const latest = useRef(invalidate);
  latest.current = invalidate;
  useEffect(
    () =>
      subscribeMeshNodes(() => {
        const next = meshNodesSignature(getMeshNodesState().nodes);
        if (next === signature.current) return;
        signature.current = next;
        latest.current();
      }),
    []
  );
}

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
  const { loading: nodesLoading } = useInventoryReadiness();

  const query = useQuery({
    queryKey: meshNotificationQueryKey,
    queryFn: ({ signal }) => fetchMeshNotificationState(apiClient, signal),
    ...meshNotificationRefreshOptions,
  });

  useInvalidateOnMeshNodesChange(() => {
    void queryClient.invalidateQueries({ queryKey: meshNotificationQueryKey });
  });

  const toggle = useMeshSinkToggle({ apiClient, selfNodeId: query.data?.selfNodeId });

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => toggle.submit(enabled),
    onSuccess: (next) => {
      // 用户取消凭据交互：什么都没改，重取一次让开关回到服务端状态。
      if (next) queryClient.setQueryData(meshNotificationQueryKey, next);
      void queryClient.invalidateQueries({ queryKey: meshNotificationQueryKey });
    },
  });

  // 成员列表还没到齐时汇聚点名字未知，`sinks` 为空会被写成「各节点只通知自身」——
  // 那是一句会误导人的结论，同步完成前继续用骨架顶着。
  if (query.isPending || nodesLoading) {
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
      {toggle.dialog}
    </MeshNotificationCardShell>
  );
}

function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof MeshSinkError) return meshSinkErrorText(t, error.code);
  return error instanceof Error && error.message ? error.message : t('common.error');
}
