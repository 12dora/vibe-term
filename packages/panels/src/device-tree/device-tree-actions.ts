import type { TmuxPane } from '@tmex/shared';
import { FolderOpen, Plus, Radar, SquareSplitHorizontal, SquareSplitVertical } from 'lucide-react';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import type { DeviceActionItem } from './device-actions-menu';

export interface SharedPaneActionTestIds {
  newSession: string;
  splitRight: string;
  splitDown: string;
  watch: string;
}

export interface SharedPaneActionContext {
  deviceId: string;
  windowId: string;
  /** 承载 cwd/split/watch 的目标 pane：窗口行取活动 pane，pane 行取自身 */
  pane?: TmuxPane;
  /** 「新建 Agent 会话」的目标 pane：窗口行取选中 pane 并回退到首个 pane */
  sessionPane: TmuxPane;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
  watchUi: boolean;
  testIds: SharedPaneActionTestIds;
  t: (key: string) => string;
  createWindow: (deviceId: string, name: string | undefined, cwd: string) => void;
  splitPane: (deviceId: string, paneId: string, direction: 'right' | 'down', cwd?: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
}

type SharedPaneAction = (ctx: SharedPaneActionContext) => DeviceActionItem | null;

const SHARED_PANE_ACTIONS: readonly SharedPaneAction[] = [
  (ctx) => {
    const { agent } = ctx;
    if (!agent) return null;
    return {
      key: 'new-session',
      testId: ctx.testIds.newSession,
      icon: Plus,
      label: ctx.t('agent.session.new'),
      onSelect: () =>
        agent.onCreateSessionForPane(ctx.nav, ctx.deviceId, ctx.windowId, ctx.sessionPane),
    };
  },
  (ctx) => {
    const cwd = ctx.pane?.currentPath;
    if (!cwd) return null;
    return {
      key: 'new-in-cwd',
      icon: FolderOpen,
      label: ctx.t('window.newInCwd'),
      onSelect: () => ctx.createWindow(ctx.deviceId, undefined, cwd),
    };
  },
  (ctx) => {
    const { pane } = ctx;
    if (!pane) return null;
    return {
      key: 'split-right',
      testId: ctx.testIds.splitRight,
      icon: SquareSplitHorizontal,
      label: ctx.t('window.splitRight'),
      onSelect: () => ctx.splitPane(ctx.deviceId, pane.id, 'right', pane.currentPath),
    };
  },
  (ctx) => {
    const { pane } = ctx;
    if (!pane) return null;
    return {
      key: 'split-down',
      testId: ctx.testIds.splitDown,
      icon: SquareSplitVertical,
      label: ctx.t('window.splitDown'),
      onSelect: () => ctx.splitPane(ctx.deviceId, pane.id, 'down', pane.currentPath),
    };
  },
  (ctx) => {
    const { pane } = ctx;
    if (!pane || !ctx.watchUi) return null;
    return {
      key: 'watch',
      testId: ctx.testIds.watch,
      icon: Radar,
      label: ctx.t('watch.openMonitor'),
      onSelect: () => ctx.onWatchPane(ctx.deviceId, pane.id),
    };
  },
];

/** 窗口行与 pane 行共用的菜单条目；重命名与关闭由各自行按窗口/pane 语义追加 */
export function buildSharedPaneActionItems(ctx: SharedPaneActionContext): DeviceActionItem[] {
  const items: DeviceActionItem[] = [];
  for (const action of SHARED_PANE_ACTIONS) {
    const item = action(ctx);
    if (item) items.push(item);
  }
  return items;
}
