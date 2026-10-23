// 「在文件管理器里打开某个目录」的唯一实现（`@vibeterm/panels/files/open-explorer`）：
// 侧栏的 useOpenInExplorer 与预览页的「返回文件管理器」都走这里。
// 独立入口只依赖路由常量与管理器 store，预览页的懒加载 chunk 引用它不会连带整个文件侧栏。

import { type AppRuntime, EXPLORER_ROUTE } from '@vibeterm/stores';
import { getExplorerStore } from '@vibeterm/stores/explorer';

/** 让管理器聚焦（或新开）该位置并切到管理器路由；压栈，浏览器后退回到出发页。 */
export function openExplorerAt(
  runtime: Pick<AppRuntime, 'nodeId' | 'host'>,
  rootId: string,
  path: string
): void {
  getExplorerStore().getState().openLocation({ nodeId: runtime.nodeId, rootId, path });
  // 管理器路由不带 node 前缀，不走 hostAppPath；宿主导航会顺带收起手机端侧栏抽屉
  runtime.host.navigate(EXPLORER_ROUTE, { replace: false });
}
