// 设备页顶栏的「+」：恒定展开下拉——首项跳设置页的多节点标签页添加远程节点，
// 其下按 ready 节点列出「添加设备到已有节点」的目标。

import { hostAppPath } from '@tmex/stores';
import { useOptionalRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Network, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { AddDeviceTarget } from './add-device-targets';

/** 设置页的多节点标签页：新增远程节点的唯一入口。 */
export const ADD_REMOTE_NODE_PATH = '/settings?tab=nodes';

export interface AddDeviceMenuListProps {
  targets: AddDeviceTarget[];
  label: string;
  selfLabel: string;
  remoteNodeLabel: string;
  remoteNodeHref: string;
  itemTitle: (target: AddDeviceTarget) => string;
}

/**
 * 下拉内容。Base UI 的 `Menu.GroupLabel` 必须挂在 `Menu.Group` 里，否则渲染即抛
 * MenuGroupRootContext 缺失（生产包表现为 "Base UI error #31" 整页崩溃）。
 */
export function AddDeviceMenuList({
  targets,
  label,
  selfLabel,
  remoteNodeLabel,
  remoteNodeHref,
  itemTitle,
}: AddDeviceMenuListProps) {
  return (
    <>
      <DropdownMenuItem
        data-testid="devices-add-remote-node"
        title={remoteNodeLabel}
        render={<Link to={remoteNodeHref} />}
      >
        <Network className="h-4 w-4" />
        <span className="min-w-0 truncate">{remoteNodeLabel}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.runtimeNodeId}
            data-testid={`devices-add-to-${target.runtimeNodeId}`}
            title={itemTitle(target)}
            onClick={() => target.open()}
          >
            <span className="min-w-0 truncate">{target.name}</span>
            {target.isSelf && (
              <span className="ml-auto shrink-0 rounded border border-border/60 px-1 py-px text-[10px] leading-none text-muted-foreground">
                {selfLabel}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}

export function AddDeviceMenu({ targets }: { targets: AddDeviceTarget[] }) {
  const { t } = useTranslation();
  const runtime = useOptionalRuntime();
  const remoteNodeHref = runtime
    ? hostAppPath(runtime.host, ADD_REMOTE_NODE_PATH)
    : ADD_REMOTE_NODE_PATH;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="devices-add"
            aria-label={t('sidebar.addDevice')}
            title={t('sidebar.addDevice')}
          />
        }
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <AddDeviceMenuList
          targets={targets}
          label={t('device.addTo.label')}
          selfLabel={t('device.addTo.self')}
          remoteNodeLabel={t('device.addTo.remoteNode')}
          remoteNodeHref={remoteNodeHref}
          itemTitle={(target) => t('devices.nodes.addDevice', { name: target.name })}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
