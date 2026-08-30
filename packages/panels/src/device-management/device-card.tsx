// 设备卡片：紧凑两行布局。第一行（可选的拖拽把手）图标/名称/SSH 目标 + 连接开关、打开与更多菜单；
// 第二行「设备种类」pill（本地 / SSH / 远程…，种类只在这里出现一次）、会话、状态徽标与
// 「侧栏显示」开关组——终端页与文件页各一个开关（浏览器本地偏好，两张表共用
// `${runtimeNodeId}:${deviceId}` 复合键）。文件开关在该设备没有配过目录时禁用，目录本身
// 由更多菜单里的「文件」入口配置。
//
// `offline`：所属节点离线，卡片来自最近一次快照——灰显、标「节点离线」、编辑/删除/测试等
// 要打远端 API 的动作禁用；连接开关仍可点（手动发起一次连接尝试）。

import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchFileRoots, testDeviceConnection } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import {
  hostAppPath,
  isSidebarDeviceVisible,
  isSidebarFilesVisible,
  sidebarDeviceVisibilityKey,
} from '@tmex/stores';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@tmex/ui/tooltip';
import {
  ArrowUpRight,
  FolderCog,
  Globe,
  Monitor,
  MoreHorizontal,
  Network,
  Pencil,
  Trash2,
  WifiOff,
  Zap,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceStatusBadge } from '../device-status-badge';
import { DeviceFilesModal } from '../settings/device-files-modal';
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

/**
 * 卡片第一行的文本：放得下就正常显示，放不下截断，悬停用 tooltip 补全文。
 * 触发器渲染成 `div`（不是默认的 `button`）：卡片里已经有一堆真按钮，
 * 名称不该再进 Tab 序。`title` 一并保留，触屏与无障碍工具仍拿得到全文。
 */
function TruncatedLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger className={cn('block truncate', className)} title={text} render={<div />}>
        {text}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
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
  onOpenFiles,
  offline,
}: Pick<DeviceCardProps, 'device' | 'onEdit' | 'onDelete'> & {
  /** 缺省表示该 runtime 关了文件 UI，不给「文件」入口 */
  onOpenFiles?: () => void;
  offline: boolean;
}) {
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
        {onOpenFiles && (
          <DropdownMenuItem
            data-testid={`device-card-files-${device.id}`}
            onClick={onOpenFiles}
            disabled={offline}
          >
            <FolderCog className="h-4 w-4" />
            {t('files.title')}
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

/**
 * 侧栏显示开关组里的一项：标签与开关同属一个 tooltip 触发器（渲染成 div，不进 Tab 序，
 * 开关本身仍可聚焦），`title` 一并保留给触屏与无障碍工具。
 */
function SidebarVisibilityToggle({
  label,
  hint,
  checked,
  disabled,
  testId,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  testId: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn('flex shrink-0 items-center gap-1', disabled && 'opacity-60')}
        title={hint}
        render={<div />}
      >
        <span>{label}</span>
        <Switch
          size="sm"
          checked={checked}
          disabled={disabled}
          data-testid={testId}
          aria-label={label}
          onCheckedChange={(value) => onCheckedChange(Boolean(value))}
        />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export const DeviceCard = memo(function DeviceCard({
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
  const filesUi = runtime.features.filesUi;
  const [filesModalOpen, setFilesModalOpen] = useState(false);
  // 开过一次就常驻挂载，关闭动画才播得完；没开过的卡片一个 modal 都不挂（一页几十张）。
  const [filesModalMounted, setFilesModalMounted] = useState(false);

  // 与文件侧栏同一个 query key：`file-roots` 设置事件失效 ['files'] 后，
  // 在弹窗里配完目录，这里的「文件」开关立刻从禁用变可用。
  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
    queryFn: () => fetchFileRoots(runtime.apiClient),
    enabled: filesUi && !offline,
    throwOnError: false,
  });
  const hasRoots = (rootsQuery.data?.roots ?? []).some((root) => root.deviceId === device.id);

  const visibilityKey = sidebarDeviceVisibilityKey(nodeId, device.id);
  const sidebarVisible = useUIStore((state) =>
    isSidebarDeviceVisible(state.sidebarDeviceVisibility, nodeId, device.id)
  );
  const setSidebarVisible = useUIStore((state) => state.setSidebarDeviceVisibility);
  const filesVisible = useUIStore((state) =>
    isSidebarFilesVisible(state.sidebarFilesVisibility, nodeId, device.id, hasRoots)
  );
  const setFilesVisible = useUIStore((state) => state.setSidebarFilesVisibility);

  const openFilesModal = () => {
    setFilesModalMounted(true);
    setFilesModalOpen(true);
  };

  const kind = deviceDisplayKind(device.type, nodeContext);
  const kindLabel = deviceKindLabel(t, kind);
  const target = sshTarget(device);

  return (
    <>
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
        <CardContent className="flex items-center gap-1.5">
          {dragHandle}
          <DeviceCardIcon device={device} remote={isRemoteDeviceKind(kind)} />
          <div className="min-w-0 flex-1">
            <TruncatedLine text={device.name} className="text-sm font-medium leading-tight" />
            {target && (
              <TruncatedLine
                text={target}
                className="text-xs leading-tight text-muted-foreground"
              />
            )}
          </div>
          {connection && (
            <DeviceCardConnectToggle
              deviceId={device.id}
              connection={connection}
              offline={offline}
            />
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
          <DeviceCardMenu
            device={device}
            onEdit={onEdit}
            onDelete={onDelete}
            onOpenFiles={filesUi ? openFilesModal : undefined}
            offline={offline}
          />
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
            data-testid={`device-card-sidebar-group-${device.id}`}
            className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground"
          >
            <span className="shrink-0">{t('device.sidebar.group')}</span>
            <SidebarVisibilityToggle
              label={t('device.sidebar.terminal')}
              hint={t('device.sidebar.terminalHint')}
              checked={sidebarVisible}
              testId={`device-card-sidebar-${device.id}`}
              onCheckedChange={(checked) => setSidebarVisible(visibilityKey, checked)}
            />
            {filesUi && (
              <SidebarVisibilityToggle
                label={t('device.sidebar.files')}
                hint={
                  hasRoots ? t('device.sidebar.filesHint') : t('device.sidebar.filesDisabledHint')
                }
                checked={hasRoots && filesVisible}
                disabled={!hasRoots}
                testId={`device-card-sidebar-files-${device.id}`}
                onCheckedChange={(checked) => setFilesVisible(visibilityKey, checked)}
              />
            )}
          </div>
        </CardContent>
      </Card>
      {filesModalMounted && (
        <DeviceFilesModal
          device={device}
          nodeId={nodeId}
          open={filesModalOpen}
          onOpenChange={setFilesModalOpen}
        />
      )}
    </>
  );
});
