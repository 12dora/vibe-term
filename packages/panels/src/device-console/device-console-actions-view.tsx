// 控制台操作区的展示层：pane 切换入口与操作按钮，顺序与 testid 不可变更。

import { PaneSwitcherMenu } from '@tmex/terminal-ui';
import { Button } from '@tmex/ui/button';
import {
  ArrowDownToLine,
  Keyboard,
  Radar,
  RefreshCw,
  Settings2,
  Smartphone,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConsoleActionsModel } from './use-device-console-actions';

export function DeviceConsoleActionsView({ model }: { model: DeviceConsoleActionsModel }) {
  const { t } = useTranslation();
  const inputModeLabel =
    model.inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect');

  return (
    <>
      {/* 移动端单 pane 展示：多 pane window 时提供切换入口（标题栏样式不变） */}
      {model.showPaneSwitcher && model.selectedWindow && model.resolvedPaneId && (
        <PaneSwitcherMenu
          window={model.selectedWindow}
          currentPaneId={model.resolvedPaneId}
          onSelectPane={model.onSwitchPane}
        />
      )}
      {/* 桌面端：对当前焦点 pane 分屏 */}
      {!model.isMobileViewport && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => model.onSplitPane('right')}
            disabled={!model.canInteract}
            data-testid="split-right-button"
            aria-label={t('window.splitRight')}
            title={t('window.splitRight')}
          >
            <SquareSplitHorizontal className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => model.onSplitPane('down')}
            disabled={!model.canInteract}
            data-testid="split-down-button"
            aria-label={t('window.splitDown')}
            title={t('window.splitDown')}
          >
            <SquareSplitVertical className="h-4 w-4" />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={model.onRefreshClick}
        aria-label={t('nav.refreshPage')}
        title={t('nav.refreshPage')}
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={model.onToggleInputMode}
        disabled={!model.canInteract}
        data-testid="terminal-input-mode-toggle"
        aria-label={inputModeLabel}
        title={inputModeLabel}
      >
        {model.inputMode === 'direct' ? (
          <Keyboard className="h-4 w-4" />
        ) : (
          <Smartphone className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={model.onJumpToLatest}
        disabled={!model.canInteract}
        aria-label={t('nav.jumpToLatest')}
        title={t('nav.jumpToLatest')}
      >
        <ArrowDownToLine className="h-4 w-4" />
      </Button>
      {model.watchUi && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          onClick={() => model.setShowWatchDialog(true)}
          disabled={!model.resolvedPaneId}
          data-testid="watch-open-button"
          aria-label={t('watch.title')}
          title={t('watch.title')}
        >
          <Radar className="h-4 w-4" />
          {model.hasEnabledWatchRule && (
            <span
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
              data-testid="watch-active-indicator"
            />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => model.setShowTerminalSettings(true)}
        data-testid="keyboard-behavior-open-button"
        aria-label={t('settings.terminal.title')}
        title={t('settings.terminal.title')}
      >
        <Settings2 className="h-4 w-4" />
      </Button>
    </>
  );
}
