// 一个标签页的导航动作 + 最近一次导航的方向（驱动目录内容的入场动画）。
// 方向和它「导航到的路径」一起记：路径被别处改掉（重命名回写、侧栏重新定位）时方向自动作废，
// 标签页重新激活时主体整体重挂，方向也回到 'none'。

import type { ExplorerBrowserProps } from '@vibeterm/panels/explorer';
import { type ExplorerTab, explorerTabPath } from '@vibeterm/stores';
import { useMemo, useState } from 'react';
import { useWorkspaceStore } from './workspace-actions';

export type NavDirection = ExplorerBrowserProps['navDirection'];

interface LastNavigation {
  direction: NavDirection;
  path: string;
}

/** 记录的方向只对它导航到的那个路径有效 */
export function resolveNavDirection(last: LastNavigation | null, path: string): NavDirection {
  return last !== null && last.path === path ? last.direction : 'none';
}

export interface TabNavigation {
  navDirection: NavDirection;
  onNavigate(path: string): void;
  onBack(): void;
  onForward(): void;
  onUp(rootPath: string): void;
  onSwitchRoot(rootId: string, rootPath: string): void;
}

export function useTabNavigation(tab: ExplorerTab): TabNavigation {
  const store = useWorkspaceStore();
  const [last, setLast] = useState<LastNavigation | null>(null);
  const tabId = tab.id;

  const handlers = useMemo(() => {
    // 先执行动作，再读回结果路径：后退 / 上一级的落点只有 store 知道
    const record = (direction: NavDirection, action: () => void) => {
      action();
      const next = store.getState().tabs[tabId];
      setLast(next ? { direction, path: explorerTabPath(next) } : null);
    };
    const actions = store.getState();
    return {
      onNavigate: (path: string) => record('forward', () => actions.navigate(tabId, path)),
      onBack: () => record('back', () => actions.goBack(tabId)),
      onForward: () => record('forward', () => actions.goForward(tabId)),
      onUp: (rootPath: string) => record('up', () => actions.goUp(tabId, rootPath)),
      onSwitchRoot: (rootId: string, rootPath: string) =>
        record('none', () => actions.switchRoot(tabId, rootId, rootPath)),
    };
  }, [store, tabId]);

  return { navDirection: resolveNavDirection(last, explorerTabPath(tab)), ...handlers };
}
