// 设备页顶栏的「+」：多个 ready 节点时展开下拉选目标节点，单个时直接开对话框。

import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AddDeviceTarget } from './add-device-targets';

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
        <DropdownMenuLabel>{t('device.addTo.label')}</DropdownMenuLabel>
        {targets.map((target) => (
          <DropdownMenuItem
            key={target.runtimeNodeId}
            data-testid={`devices-add-to-${target.runtimeNodeId}`}
            title={t('devices.nodes.addDevice', { name: target.name })}
            onClick={target.open}
          >
            <span className="min-w-0 truncate">{target.name}</span>
            {target.isSelf && (
              <span className="ml-auto shrink-0 rounded border border-border/60 px-1 py-px text-[10px] leading-none text-muted-foreground">
                {t('device.addTo.self')}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
