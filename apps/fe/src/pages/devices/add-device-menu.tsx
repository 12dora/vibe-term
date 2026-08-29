// 设备页顶栏的「+」：多个 ready 节点时展开下拉选目标节点，单个时直接开对话框。

import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AddDeviceTarget } from './add-device-targets';

export interface AddDeviceMenuListProps {
  targets: AddDeviceTarget[];
  label: string;
  selfLabel: string;
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
  itemTitle,
}: AddDeviceMenuListProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {targets.map((target) => (
        <DropdownMenuItem
          key={target.runtimeNodeId}
          data-testid={`devices-add-to-${target.runtimeNodeId}`}
          title={itemTitle(target)}
          onClick={target.open}
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
  );
}

export function AddDeviceMenu({ targets }: { targets: AddDeviceTarget[] }) {
  const { t } = useTranslation();

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
      <DropdownMenuContent align="end" className="min-w-44">
        <AddDeviceMenuList
          targets={targets}
          label={t('device.addTo.label')}
          selfLabel={t('device.addTo.self')}
          itemTitle={(target) => t('devices.nodes.addDevice', { name: target.name })}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
