// 预览页「返回文件管理器」：让管理器聚焦到文件所在目录，再切到管理器路由。

import { openExplorerAt } from '@vibeterm/panels/files/open-explorer';
import { dirname } from '@vibeterm/shared';
import type { AppRuntime, FileRef } from '@vibeterm/stores';

export function backToFileManager(
  runtime: Pick<AppRuntime, 'nodeId' | 'host'>,
  ref: FileRef
): void {
  openExplorerAt(runtime, ref.rootId, dirname(ref.path));
}
