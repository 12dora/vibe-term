// 操作区按钮的表驱动渲染：按钮模型由纯函数构建，组件只负责映射成 <Button>。
// 顶栏只留分屏与终端设置两类图标按钮，刷新 / 输入模式 / 分享 / 监视规则收进末尾的 ⋯ 菜单，
// 分享中与「有启用规则」的角标在菜单收起时汇成触发器上的一个点。

import { PaneSwitcherMenu } from '@vibeterm/terminal-ui';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import {
  Ellipsis,
  Keyboard,
  type LucideIcon,
  Radar,
  RefreshCw,
  Settings2,
  Share2,
  Smartphone,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConsoleActionsModel } from './use-device-console-actions';

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export interface ToolbarButton {
  key: string;
  testId?: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 角标：visible 控制显示；给了 count 就显示数字（分享在线人数），否则是个小圆点 */
  badge?: { testId: string; visible: boolean; count?: number };
  /** 功能正在生效（如该 tab 正在分享），按钮以高亮态渲染 */
  active?: boolean;
}

/** 收进「更多」菜单的动作，模型与图标按钮同构 */
export type ToolbarMenuItem = ToolbarButton;

export interface ToolbarButtonsInput {
  model: DeviceConsoleActionsModel;
  t: TranslateFn;
  onOpenRefreshConfirm: () => void;
  onOpenWatchDialog: () => void;
  onOpenTerminalSettings: () => void;
  onOpenShareDialog: () => void;
}

function splitButtons({ model, t }: ToolbarButtonsInput): ToolbarButton[] {
  return [
    {
      key: 'split-right',
      testId: 'split-right-button',
      icon: SquareSplitHorizontal,
      label: t('window.splitRight'),
      disabled: !model.canInteract,
      onClick: () => model.onSplitPane('right'),
    },
    {
      key: 'split-down',
      testId: 'split-down-button',
      icon: SquareSplitVertical,
      label: t('window.splitDown'),
      disabled: !model.canInteract,
      onClick: () => model.onSplitPane('down'),
    },
  ];
}

function coreMenuItems({ model, t, onOpenRefreshConfirm }: ToolbarButtonsInput): ToolbarMenuItem[] {
  const isDirectInput = model.inputMode === 'direct';
  return [
    {
      key: 'refresh',
      testId: 'refresh-page-button',
      icon: RefreshCw,
      label: t('nav.refreshPage'),
      onClick: onOpenRefreshConfirm,
    },
    {
      key: 'input-mode',
      testId: 'terminal-input-mode-toggle',
      icon: isDirectInput ? Keyboard : Smartphone,
      label: isDirectInput ? t('nav.switchToEditor') : t('nav.switchToDirect'),
      disabled: !model.canInteract,
      onClick: model.onToggleInputMode,
    },
  ];
}

function watchItem({ model, t, onOpenWatchDialog }: ToolbarButtonsInput): ToolbarMenuItem {
  return {
    key: 'watch',
    testId: 'watch-open-button',
    icon: Radar,
    label: t('watch.title'),
    disabled: !model.resolvedPaneId,
    onClick: onOpenWatchDialog,
    badge: { testId: 'watch-active-indicator', visible: model.hasEnabledWatchRule },
  };
}

function shareItem({ model, t, onOpenShareDialog }: ToolbarButtonsInput): ToolbarMenuItem {
  const sharing = model.hasActiveShare;
  return {
    key: 'share',
    testId: 'share-open-button',
    icon: Share2,
    label: sharing
      ? t('share.toolbar.active', { count: model.shareViewers })
      : t('share.toolbar.share'),
    disabled: !(model.deviceId && model.windowId),
    active: sharing,
    onClick: onOpenShareDialog,
    badge: { testId: 'share-active-indicator', visible: sharing, count: model.shareViewers },
  };
}

function terminalSettingsButton({ t, onOpenTerminalSettings }: ToolbarButtonsInput): ToolbarButton {
  return {
    key: 'terminal-settings',
    testId: 'keyboard-behavior-open-button',
    icon: Settings2,
    label: t('settings.terminal.title'),
    onClick: onOpenTerminalSettings,
  };
}

/** 留在顶栏的图标按钮：分屏与终端设置，其余动作收进「更多」菜单 */
export function buildToolbarButtons(input: ToolbarButtonsInput): ToolbarButton[] {
  return [
    ...(input.model.isMobileViewport || !input.model.structureUi ? [] : splitButtons(input)),
    terminalSettingsButton(input),
  ];
}

/** 「更多」菜单里的动作：刷新页面、输入模式、分享、监视规则 */
export function buildToolbarMenuItems(input: ToolbarButtonsInput): ToolbarMenuItem[] {
  return [
    ...coreMenuItems(input),
    ...(input.model.shareUi ? [shareItem(input)] : []),
    ...(input.model.watchUi ? [watchItem(input)] : []),
  ];
}

/** 菜单收起时，把里面还亮着的角标（分享中 / 有启用的监视规则）汇成触发器上的一个点 */
export function hasToolbarMenuIndicator(items: readonly ToolbarMenuItem[]): boolean {
  return items.some((item) => item.badge?.visible === true);
}

function ToolbarBadge({ badge }: { badge: NonNullable<ToolbarButton['badge']> }) {
  if (badge.count === undefined) {
    return (
      <span
        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
        data-testid={badge.testId}
      />
    );
  }
  return (
    <span
      className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[10px] font-medium leading-[14px] text-primary-foreground"
      data-testid={badge.testId}
    >
      {badge.count}
    </span>
  );
}

/** 气泡文案与 aria-label 同源，且不再挂 title——否则原生提示会和气泡叠着出两层。 */
export function ToolbarIconButton({ button }: { button: ToolbarButton }) {
  const Icon = button.icon;
  return (
    <IconTooltip label={button.label}>
      <Button
        variant={button.active ? 'secondary' : 'ghost'}
        size="icon-sm"
        className={cn(button.badge && 'relative', button.active && 'text-primary')}
        onClick={button.onClick}
        disabled={button.disabled}
        data-testid={button.testId}
        data-active={button.active ? 'true' : undefined}
        aria-label={button.label}
      >
        <Icon className="h-4 w-4" />
        {button.badge?.visible && <ToolbarBadge badge={button.badge} />}
      </Button>
    </IconTooltip>
  );
}

const MENU_CONTENT_CLASS = 'w-auto min-w-44 [@media(any-pointer:coarse)]:min-w-52';
const MENU_ITEM_CLASS =
  'gap-2 px-2 py-1.5 [@media(any-pointer:coarse)]:px-2.5 [@media(any-pointer:coarse)]:py-2.5';

function MenuItemBadge({ badge }: { badge: NonNullable<ToolbarMenuItem['badge']> }) {
  if (badge.count === undefined) {
    return (
      <span
        className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
        data-testid={badge.testId}
      />
    );
  }
  return (
    <span
      className="ml-auto min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 text-primary-foreground"
      data-testid={badge.testId}
    >
      {badge.count}
    </span>
  );
}

export interface ToolbarMoreMenuProps {
  items: ToolbarMenuItem[];
  label: string;
}

/**
 * 顶栏「更多」：刷新 / 输入模式 / 分享 / 监视规则四项收进来，顶栏只留分屏与终端设置。
 * finalFocus 一律关掉：菜单关闭后焦点归对话框或终端自己管。base-ui 分不清 Esc 关闭
 * 与回车选中菜单项（两者的 closeType 都是 'keyboard'），回焦发生在菜单项 onClick 打开
 * 对话框之后，焦点会落到被 aria-hidden 盖住的触发器上，Esc / 回车就都操作不到对话框。
 * 代价是 Esc 关菜单不再把焦点送回触发器，这条已接受。
 */
export function ToolbarMoreMenu({ items, label }: ToolbarMoreMenuProps) {
  return (
    <DropdownMenu>
      <IconTooltip label={label}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              data-testid="console-more-button"
              aria-label={label}
            />
          }
        >
          <Ellipsis className="h-4 w-4" />
          {hasToolbarMenuIndicator(items) && (
            <span
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
              data-testid="console-more-indicator"
            />
          )}
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent
        align="end"
        backdrop
        className={MENU_CONTENT_CLASS}
        data-testid="console-more-menu"
        finalFocus={false}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.key}
              className={MENU_ITEM_CLASS}
              data-testid={item.testId}
              disabled={item.disabled}
              onClick={item.onClick}
            >
              <Icon className="h-4 w-4" />
              <span className="min-w-0 truncate">{item.label}</span>
              {item.badge?.visible && <MenuItemBadge badge={item.badge} />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type DeviceConsoleToolbarProps = Omit<ToolbarButtonsInput, 't'>;

export function DeviceConsoleToolbar(props: DeviceConsoleToolbarProps) {
  const { t } = useTranslation();
  const { model } = props;
  const buttons = buildToolbarButtons({ ...props, t });
  const menuItems = buildToolbarMenuItems({ ...props, t });
  const showPaneSwitcher =
    model.isMobileViewport &&
    Boolean(model.resolvedPaneId) &&
    (model.selectedWindow?.panes.length ?? 0) > 1;

  return (
    <>
      {showPaneSwitcher && model.selectedWindow && model.resolvedPaneId && (
        <PaneSwitcherMenu
          window={model.selectedWindow}
          currentPaneId={model.resolvedPaneId}
          onSelectPane={model.onSwitchPane}
        />
      )}
      {buttons.map((button) => (
        <ToolbarIconButton key={button.key} button={button} />
      ))}
      <ToolbarMoreMenu items={menuItems} label={t('nav.more')} />
    </>
  );
}
