// 操作区按钮的表驱动渲染：按钮模型由纯函数构建，组件只负责映射成 <Button>。

import { PaneSwitcherMenu } from '@tmex/terminal-ui';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { IconTooltip } from '@tmex/ui/icon-tooltip';
import {
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

function coreButtons({ model, t, onOpenRefreshConfirm }: ToolbarButtonsInput): ToolbarButton[] {
  const isDirectInput = model.inputMode === 'direct';
  return [
    {
      key: 'refresh',
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

function watchButton({ model, t, onOpenWatchDialog }: ToolbarButtonsInput): ToolbarButton {
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

function shareButton({ model, t, onOpenShareDialog }: ToolbarButtonsInput): ToolbarButton {
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

export function buildToolbarButtons(input: ToolbarButtonsInput): ToolbarButton[] {
  return [
    ...(input.model.isMobileViewport || !input.model.structureUi ? [] : splitButtons(input)),
    ...coreButtons(input),
    ...(input.model.shareUi ? [shareButton(input)] : []),
    ...(input.model.watchUi ? [watchButton(input)] : []),
    terminalSettingsButton(input),
  ];
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

export type DeviceConsoleToolbarProps = Omit<ToolbarButtonsInput, 't'>;

export function DeviceConsoleToolbar(props: DeviceConsoleToolbarProps) {
  const { t } = useTranslation();
  const { model } = props;
  const buttons = buildToolbarButtons({ ...props, t });
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
    </>
  );
}
