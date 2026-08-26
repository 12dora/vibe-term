import { cn } from '@tmex/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { EllipsisVertical, type LucideIcon } from 'lucide-react';

export interface DeviceActionItem {
  key: string;
  testId?: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export interface DeviceActionsMenuProps {
  triggerTestId: string;
  triggerLabel: string;
  /** 仅窗口行带 title；pane 行保持无 title 属性 */
  triggerTitle?: string;
  triggerClassName: string;
  triggerIconClassName: string;
  isMobile: boolean;
  items: DeviceActionItem[];
}

const TRIGGER_BASE_CLASS =
  'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity data-popup-open:opacity-100';

const CONTENT_CLASS = 'w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48';

/** 按 action model 渲染的窗口/pane 行操作菜单；两处共用同一套触发器与条目样式 */
export function DeviceActionsMenu({
  triggerTestId,
  triggerLabel,
  triggerTitle,
  triggerClassName,
  triggerIconClassName,
  isMobile,
  items,
}: DeviceActionsMenuProps) {
  const itemClassName = cn(
    '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
    isMobile && 'py-3 px-2.5 text-base gap-2.5'
  );
  const iconClassName = cn('h-4 w-4', isMobile && 'h-5 w-5');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={triggerTestId}
        aria-label={triggerLabel}
        title={triggerTitle}
        className={cn(TRIGGER_BASE_CLASS, triggerClassName)}
      >
        <EllipsisVertical className={triggerIconClassName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" backdrop className={CONTENT_CLASS}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.key}
              variant={item.destructive ? 'destructive' : 'default'}
              data-testid={item.testId}
              className={itemClassName}
              onClick={item.onSelect}
            >
              <Icon className={iconClassName} />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
