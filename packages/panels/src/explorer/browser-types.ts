// 一个标签页的浏览器对宿主的属性契约。

import type { ExplorerClipboard, ExplorerSort, ExplorerViewMode } from '@vibeterm/stores';
import type { ExplorerTransferRequest } from './transfer-request';

export type ExplorerNavDirection = 'forward' | 'back' | 'up' | 'none';

export type ExplorerHostCommand = 'newTab' | 'closeTab' | 'split';

export interface ExplorerBrowserProps {
  tabId: string;
  rootId: string;
  path: string;
  canBack: boolean;
  canForward: boolean;
  /** 本标签页是键盘的属主（活动分栏的活动标签页） */
  active: boolean;
  viewMode: ExplorerViewMode;
  showHidden: boolean;
  sort: ExplorerSort;
  clipboard: ExplorerClipboard | null;
  /** 最近一次导航的方向，决定入场动画 */
  navDirection: ExplorerNavDirection;
  onNavigate(path: string): void;
  onBack(): void;
  onForward(): void;
  onUp(rootPath: string): void;
  onSwitchRoot(rootId: string, rootPath: string): void;
  onOpenInNewTab(path: string): void;
  onViewModeChange(mode: ExplorerViewMode): void;
  onShowHiddenChange(show: boolean): void;
  onSortChange(sort: ExplorerSort): void;
  onClipboardChange(clipboard: ExplorerClipboard | null): void;
  /** 粘贴 / 从别处拖入：由宿主执行（移动接口或跨设备复制任务） */
  onTransfer(request: ExplorerTransferRequest): void;
  /** 标签页级快捷键交给宿主 */
  onCommand?(command: ExplorerHostCommand): void;
  /** 本分栏被点击 / 聚焦（宿主把它设为活动分栏） */
  onActivate(): void;
  /** 根目录查不到（已移除或停用），宿主显示「关闭标签页」状态 */
  onRootMissing?(): void;
}
