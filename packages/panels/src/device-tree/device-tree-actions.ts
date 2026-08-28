import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  FolderOpen,
  Pencil,
  Plus,
  Radar,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react';
import type { DeviceActionItem } from './device-actions-menu';
import { pickActivePane } from './device-tree-navigation';

export type SplitDirection = 'right' | 'down';

/** 只取 i18n 的字符串取值面，避免行组件把整个 TFunction 泄进纯函数 */
export type TranslateFn = (key: string) => string;

export interface DeviceTreeActionHandlers {
  onRename: () => void;
  /** pane 为空的窗口没有可挂载的目标，调用方传 undefined 让该项整条消失 */
  onCreateSession?: () => void;
  onCreateWindowInCwd: (cwd: string) => void;
  onSplit: (paneId: string, direction: SplitDirection, cwd?: string) => void;
  onWatch: (paneId: string) => void;
  onClose: () => void;
}

export interface WindowActionsInput extends DeviceTreeActionHandlers {
  t: TranslateFn;
  tmuxWindow: TmuxWindow;
  watchUi: boolean;
}

export interface PaneActionsInput extends DeviceTreeActionHandlers {
  t: TranslateFn;
  pane: TmuxPane;
  watchUi: boolean;
}

function splitItems(
  t: TranslateFn,
  testId: (key: 'split-right' | 'split-down') => string,
  pane: TmuxPane,
  onSplit: DeviceTreeActionHandlers['onSplit']
): DeviceActionItem[] {
  return [
    {
      key: 'split-right',
      testId: testId('split-right'),
      icon: SquareSplitHorizontal,
      label: t('window.splitRight'),
      onSelect: () => onSplit(pane.id, 'right', pane.currentPath),
    },
    {
      key: 'split-down',
      testId: testId('split-down'),
      icon: SquareSplitVertical,
      label: t('window.splitDown'),
      onSelect: () => onSplit(pane.id, 'down', pane.currentPath),
    },
  ];
}

export function buildWindowActions({
  t,
  tmuxWindow,
  watchUi,
  onRename,
  onCreateSession,
  onCreateWindowInCwd,
  onSplit,
  onWatch,
  onClose,
}: WindowActionsInput): DeviceActionItem[] {
  const activePane = pickActivePane(tmuxWindow.panes);
  const activePaneCwd = activePane?.currentPath;

  const items: DeviceActionItem[] = [
    {
      key: 'rename',
      testId: `window-menu-rename-${tmuxWindow.id}`,
      icon: Pencil,
      label: t('window.rename'),
      onSelect: onRename,
    },
  ];

  if (onCreateSession) {
    items.push({
      key: 'new-session',
      testId: `window-menu-new-session-${tmuxWindow.id}`,
      icon: Plus,
      label: t('agent.session.new'),
      onSelect: onCreateSession,
    });
  }

  if (activePaneCwd) {
    items.push({
      key: 'new-in-cwd',
      icon: FolderOpen,
      label: t('window.newInCwd'),
      onSelect: () => onCreateWindowInCwd(activePaneCwd),
    });
  }

  if (activePane) {
    // 窗口菜单的 split/watch 沿用窗口 id 做 testId，与 pane 行的同名条目区分
    items.push(
      ...splitItems(t, (key) => `window-menu-${key}-${tmuxWindow.id}`, activePane, onSplit)
    );
    if (watchUi) {
      items.push({
        key: 'watch',
        testId: `window-menu-watch-${tmuxWindow.id}`,
        icon: Radar,
        label: t('watch.openMonitor'),
        onSelect: () => onWatch(activePane.id),
      });
    }
  }

  items.push({
    key: 'close',
    testId: `window-menu-close-${tmuxWindow.id}`,
    icon: X,
    label: t('window.close'),
    destructive: true,
    onSelect: onClose,
  });

  return items;
}

export function buildPaneActions({
  t,
  pane,
  watchUi,
  onRename,
  onCreateSession,
  onCreateWindowInCwd,
  onSplit,
  onWatch,
  onClose,
}: PaneActionsInput): DeviceActionItem[] {
  const items: DeviceActionItem[] = [
    {
      key: 'rename',
      testId: `pane-menu-rename-${pane.id}`,
      icon: Pencil,
      label: t('window.rename'),
      onSelect: onRename,
    },
  ];

  if (onCreateSession) {
    items.push({
      key: 'new-session',
      testId: `pane-menu-new-session-${pane.id}`,
      icon: Plus,
      label: t('agent.session.new'),
      onSelect: onCreateSession,
    });
  }

  if (pane.currentPath) {
    const cwd = pane.currentPath;
    items.push({
      key: 'new-in-cwd',
      icon: FolderOpen,
      label: t('window.newInCwd'),
      onSelect: () => onCreateWindowInCwd(cwd),
    });
  }

  items.push(...splitItems(t, (key) => `pane-${key}-${pane.id}`, pane, onSplit));

  if (watchUi) {
    items.push({
      key: 'watch',
      testId: `pane-watch-${pane.id}`,
      icon: Radar,
      label: t('watch.openMonitor'),
      onSelect: () => onWatch(pane.id),
    });
  }

  items.push({
    key: 'close',
    testId: `pane-menu-close-${pane.id}`,
    icon: X,
    label: t('window.closePane'),
    destructive: true,
    onSelect: onClose,
  });

  return items;
}
