// 「还能不能再分栏」的唯一判据：顶栏按钮、标签页菜单、键盘命令都问这里。
// 窄屏只画一个分栏，再分出来的栏会把原来那栏的内容挤出视野，所以一律不许分。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import { EXPLORER_MAX_PANES, useExplorerStore } from '@vibeterm/stores/explorer';

export interface SplitAvailability {
  paneCount: number;
  narrow: boolean;
  hasTab: boolean;
}

export function canSplitWorkspace({ paneCount, narrow, hasTab }: SplitAvailability): boolean {
  return hasTab && !narrow && paneCount < EXPLORER_MAX_PANES;
}

export function useCanSplit(): boolean {
  const paneCount = useExplorerStore((state) => state.panes.length);
  const hasTab = useExplorerStore((state) => Object.keys(state.tabs).length > 0);
  const narrow = useNarrowLayout();
  return canSplitWorkspace({ paneCount, narrow, hasTab });
}
