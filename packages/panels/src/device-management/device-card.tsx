// 设备卡片：紧凑两行布局。第一行图标/名称/副标题 + 连接与更多菜单，第二行类型与状态徽标
// + 「显示在侧栏」开关（浏览器本地偏好，按 `${runtimeNodeId}:${deviceId}` 记）。

import { useMutation } from '@tanstack/react-query';
import { testDeviceConnection } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { hostAppPath, isSidebarDeviceVisible, sidebarDeviceVisibilityKey } from '@tmex/stores';
import { useRuntime, useUIStore } from '@tmex/stores/react';
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
import { Globe, Monitor, MoreHorizontal, Pencil, Trash2, Zap } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DeviceStatusBadge } from '../device-status-badge';

export interface DeviceCardProps {
  device: Device;
  onEdit: () => void;
  onDelete: () => void;
  /** 该设备所属 node 的运行时 id；缺省取当前运行时（`self` 即 entry 自身）。 */
  runtimeNodeId?: string;
  /** 卡片根节点内联样式；列表用它挂 `--tmex-stagger-index` 做逐项入场 */
  style?: CSSProperties;
}

export function DeviceCard({ device, onEdit, onDelete, runtimeNodeId, style }: DeviceCardProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const nodeId = runtimeNodeId ?? runtime.nodeId;

  const sidebarVisible = useUIStore((state) =>
    isSidebarDeviceVisible(state.sidebarDeviceVisibility, nodeId, device.id)
  );
  const setSidebarVisible = useUIStore((state) => state.setSidebarDeviceVisibility);

  const icon =
    device.type === 'local' ? <Monitor className="h-4 w-4" /> : <Globe className="h-4 w-4" />;
  const subtitle =
    device.type === 'local'
      ? t('device.typeLocal')
      : `${device.username ?? '-'}@${device.host ?? '-'}:${device.port ?? 22}`;

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
    <Card
      size="sm"
      data-testid="device-card"
      data-device-id={device.id}
      data-device-name={device.name}
      style={style}
      className="gap-2 overflow-hidden border-border/50 py-2.5 transition-[box-shadow,border-color] duration-(--tmex-motion-standard) ease-out hover:shadow-md hover:ring-foreground/20 motion-reduce:transition-none"
    >
      <CardContent className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight" title={device.name}>
            {device.name}
          </div>
          <div className="truncate text-xs leading-tight text-muted-foreground" title={subtitle}>
            {subtitle}
          </div>
        </div>
        <Link
          to={hostAppPath(runtime.host, `/devices/${device.id}`)}
          data-testid={`device-card-connect-${device.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}
        >
          {t('device.connect')}
        </Link>
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
            <DropdownMenuItem data-testid={`device-card-edit-${device.id}`} onClick={onEdit}>
              <Pencil className="h-4 w-4" />
              {t('common.edit')}
            </DropdownMenuItem>
            {device.type === 'ssh' && (
              <DropdownMenuItem
                data-testid={`device-card-test-${device.id}`}
                onClick={() => testConnection.mutate()}
                disabled={testConnection.isPending}
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
            >
              <Trash2 className="h-4 w-4" />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardContent>

      <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
          {device.type === 'local' ? t('device.typeLocal') : t('device.typeSSHBadge')}
        </Badge>
        {device.session && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
            {device.session}
          </Badge>
        )}
        <DeviceStatusBadge deviceId={device.id} />
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
