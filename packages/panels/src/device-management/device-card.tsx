// 设备卡片：紧凑两行布局。第一行（可选的拖拽把手）图标/名称/SSH 目标 + 连接开关、打开与更多菜单；
// 第二行「设备种类」pill（本地 / SSH / 远程…，种类只在这里出现一次）、会话、
// 状态徽标与「显示在侧栏」开关（浏览器本地偏好，按 `${runtimeNodeId}:${deviceId}` 记）。
//
// `offline`：所属节点离线，卡片来自最近一次快照——灰显、标「节点离线」、编辑/删除/测试等
// 要打远端 API 的动作禁用；连接开关仍可点（手动发起一次连接尝试）。

import { useMutation } from '@tanstack/react-query';
import { testDeviceConnection } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { hostAppPath, isSidebarDeviceVisible, sidebarDeviceVisibilityKey } from '@tmex/stores';
import { useRuntime, useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Badge } from '@tmex/ui/badge';
import { Button, buttonVariants } from '@tmex/ui/button';
import { Card, CardContent } from '@tmex/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Switch } from '@tmex/ui/switch';
import {
  ArrowUpRight,
  Globe,
  Monitor,
  MoreHorizontal,
  Network,
  Pencil,
  Trash2,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceStatusBadge } from '../device-status-badge';
import { DeviceCardConnectToggle } from './device-card-connect-toggle';
import {
  type DeviceNodeContext,
  deviceDisplayKind,
  deviceKindLabel,
  isRemoteDeviceKind,
} from './device-node-context';

export interface DeviceCardProps {
  device: Device;
  onEdit: () => void;
  onDelete: () => void;
  /** 该设备所属 node 的展示上下文；由宿主（DeviceCardHost / 面板）注入 */
  nodeContext: DeviceNodeContext;
  /** 有它才显示真实的连接/断开开关；缺省时只留「打开」 */
  connection?: DeviceConnectionAdapter;
  /** 所属节点离线：灰显 + 禁用需要远端 API 的操作 */
  offline?: boolean;
  /** 节点内排序的把手（宿主注入），渲染在第一行最左 */
  dragHandle?: ReactNode;
  /** 卡片根节点内联样式；列表用它挂 `--tmex-stagger-index` 做逐项入场 */
  style?: CSSProperties;
  className?: string;
}

/** SSH 目标只对 SSH 设备有信息量；本地设备不渲染第二行，种类交给底部 pill。 */
function sshTarget(device: Device): string | null {
  if (device.type !== 'ssh') return null;
  return `${device.username ?? '-'}@${device.host ?? '-'}:${device.port ?? 22}`;
}

function DeviceCardIcon({ device, remote }: { device: Device; remote: boolean }) {
  return (
    <div className="relative shrink-0">
      <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
        {device.type === 'local' ? <Monitor className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
      </div>
      {remote && (
        <span
          aria-hidden="true"
          data-testid={`device-card-remote-${device.id}`}
          className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-background bg-muted text-muted-foreground"
        >
          <Network className="h-2.5 w-2.5" />
        </span>
      )}
    </div>
  );
}

function DeviceCardMenu({
  device,
  onEdit,
  onDelete,
  offline,
}: Pick<DeviceCardProps, 'device' | 'onEdit' | 'onDelete'> & { offline: boolean }) {
  const { t } = useTranslation();
  const runtime = useRuntime();

  const testConnection = useMutation({
    mutationFn: () => testDeviceConnection(device.id, t('common.error'), runtime.apiClient),
    onSuccess: (payload) => {
      toast.success(payload.message ?? t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            data-testid={`device-card-actions-${device.id}`}
            aria-label={t('common.edit')}
            title={t('common.edit')}
          />
        }
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid={`device-card-edit-${device.id}`}
          onClick={onEdit}
          disabled={offline}
        >
          <Pencil className="h-4 w-4" />
          {t('common.edit')}
        </DropdownMenuItem>
        {device.type === 'ssh' && (
          <DropdownMenuItem
            data-testid={`device-card-test-${device.id}`}
            onClick={() => testConnection.mutate()}
            disabled={offline || testConnection.isPending}
          >
            <Zap className="h-4 w-4" />
            {t('common.test')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={`device-card-delete-${device.id}`}
          variant="destructive"
          onClick={onDelete}
          disabled={offline}
        >
          <Trash2 className="h-4 w-4" />
          {t('common.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DeviceCard({
  device,
  onEdit,
  onDelete,
  nodeContext,
  connection,
  offline = false,
  dragHandle,
  style,
  className,
}: DeviceCardProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const nodeId = nodeContext.runtimeNodeId;

  const sidebarVisible = useUIStore((state) =>
    isSidebarDeviceVisible(state.sidebarDeviceVisibility, nodeId, device.id)
  );
  const setSidebarVisible = useUIStore((state) => state.setSidebarDeviceVisibility);

  const kind = deviceDisplayKind(device.type, nodeContext);
  const kindLabel = deviceKindLabel(t, kind);
  const target = sshTarget(device);

  return (
    <Card
      size="sm"
      data-testid="device-card"
      data-device-id={device.id}
      data-device-name={device.name}
      data-device-kind={kind}
      data-offline={offline ? 'true' : undefined}
      style={style}
      className={cn(
        'gap-2 overflow-hidden border-border/50 py-2.5 transition-[box-shadow,border-color,opacity] duration-(--tmex-motion-standard) ease-out hover:shadow-md hover:ring-foreground/20 motion-reduce:transition-none',
        offline && 'border-dashed bg-muted/20 opacity-75 hover:shadow-none',
        className
      )}
    >
      <CardContent className="flex items-center gap-2">
        {dragHandle}
        <DeviceCardIcon device={device} remote={isRemoteDeviceKind(kind)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight" title={device.name}>
            {device.name}
          </div>
          {target && (
            <div className="truncate text-xs leading-tight text-muted-foreground" title={target}>
              {target}
            </div>
          )}
        </div>
        {connection && (
          <DeviceCardConnectToggle deviceId={device.id} connection={connection} offline={offline} />
        )}
        <Link
          to={hostAppPath(runtime.host, `/devices/${device.id}`)}
          data-testid={`device-card-open-${device.id}`}
          aria-label={t('device.open')}
          title={t('device.open')}
          className={buttonVariants({
            variant: connection ? 'ghost' : 'outline',
            size: connection ? 'icon-sm' : 'sm',
            className: 'shrink-0',
          })}
        >
          <ArrowUpRight className="h-4 w-4" />
          {connection ? null : t('device.open')}
        </Link>
        <DeviceCardMenu device={device} onEdit={onEdit} onDelete={onDelete} offline={offline} />
      </CardContent>

      <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge
          variant="outline"
          data-testid={`device-card-kind-${device.id}`}
          className="max-w-full truncate px-1.5 py-0 text-[10px] font-normal"
        >
          {kindLabel}
        </Badge>
        {device.session && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
            {device.session}
          </Badge>
        )}
        {offline ? (
          <Badge
            variant="outline"
            data-testid={`device-card-offline-${device.id}`}
            className="h-5 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <WifiOff className="h-3 w-3" />
            {t('devices.nodes.deviceOffline')}
          </Badge>
        ) : (
          <DeviceStatusBadge deviceId={device.id} />
        )}
        <div
          className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
          title={t('device.sidebar.hint')}
        >
          <span>{t('device.sidebar.show')}</span>
          <Switch
            size="sm"
            checked={sidebarVisible}
            data-testid={`device-card-sidebar-${device.id}`}
            aria-label={t('device.sidebar.show')}
            onCheckedChange={(checked) =>
              setSidebarVisible(sidebarDeviceVisibilityKey(nodeId, device.id), Boolean(checked))
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
