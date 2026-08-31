// 操作区按钮的表驱动渲染：按钮模型由纯函数构建，组件只负责映射成 <Button>。

import { PaneSwitcherMenu } from '@tmex/terminal-ui';
import { Button } from '@tmex/ui/button';
import { IconTooltip } from '@tmex/ui/icon-tooltip';
import {
  Keyboard,
  type LucideIcon,
  Radar,
  RefreshCw,
  Settings2,
  Smartphone,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConsoleActionsModel } from './use-device-console-actions';

export type TranslateFn = (key: string) => string;

export interface ToolbarButton {
  key: string;
  testId?: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 仅 watch 按钮带角标：visible 控制小圆点显示 */
  badge?: { testId: string; visible: boolean };
}

export interface ToolbarButtonsInput {
  model: DeviceConsoleActionsModel;
  t: TranslateFn;
  onOpenRefreshConfirm: () => void;
  onOpenWatchDialog: () => void;
  onOpenTerminalSettings: () => void;
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
    ...(input.model.isMobileViewport ? [] : splitButtons(input)),
    ...coreButtons(input),
    ...(input.model.watchUi ? [watchButton(input)] : []),
    terminalSettingsButton(input),
  ];
}

/** 气泡文案与 aria-label 同源，且不再挂 title——否则原生提示会和气泡叠着出两层。 */
export function ToolbarIconButton({ button }: { button: ToolbarButton }) {
  const Icon = button.icon;
  return (
    <IconTooltip label={button.label}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={button.badge ? 'relative' : undefined}
        onClick={button.onClick}
        disabled={button.disabled}
        data-testid={button.testId}
        aria-label={button.label}
      >
        <Icon className="h-4 w-4" />
        {button.badge?.visible && (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
            data-testid={button.badge.testId}
          />
        )}
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
