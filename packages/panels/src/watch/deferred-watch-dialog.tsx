// 监视规则对话框按需加载。
//
// WatchDialog 拖着一整棵表单树（规则列表 / 规则表单 / LLM 字段 / 正则字段 / 调度字段 /
// 状态视图，约 1.4 K 行），却被两条静态边钉在首屏 chunk 上：常驻侧栏的
// `device-tree-dialogs` 与控制台工具栏的 `page-actions`。它是模态框，不打开不渲染，
// 首屏一个字节都用不上。这里只保留「打开过才挂载」的边界，行为与直接渲染一致。
//
// 失败兜底与 `deferred-terminal-settings-sheet` 同理：发版后旧 index.html 指向的 chunk
// 已经不存在，import() 会 404。控制台侧用 `useWatchDialogPreload` 在空闲时预热，趁当前
// index 还新鲜先把 chunk 拉下来，绕开这个窗口。

import { Suspense, lazy, useEffect, useState } from 'react';

export interface DeferredWatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
}

const WatchDialogLazy = lazy(() =>
  import('./watch-dialog').then((module) => ({ default: module.WatchDialog }))
);

/** 预取对话框 chunk；浏览器模块表按 specifier 去重，之后 `lazy` 直接命中缓存。 */
export function preloadWatchDialog(): Promise<unknown> {
  return import('./watch-dialog');
}

function scheduleIdle(run: () => void): () => void {
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(run, { timeout: 3000 });
    return () => globalThis.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 1200);
  return () => clearTimeout(timer);
}

/** 首帧之后空闲预热监视对话框 chunk；失败静默，真正打开时再走一次 import。 */
export function useWatchDialogPreload(): void {
  useEffect(
    () =>
      scheduleIdle(() => {
        void preloadWatchDialog().catch(() => undefined);
      }),
    []
  );
}

/**
 * 只有「被打开过」才挂载真正的对话框：`open` 首次为真时才发起 import，关闭后保持挂载，
 * 与原先直接渲染 `WatchDialog` 的开合语义一致。加载期间渲染 null——模态框本来就没有
 * 占位可言，出现得晚一帧不影响任何既有交互。
 */
export function DeferredWatchDialog(props: DeferredWatchDialogProps) {
  const { open } = props;
  const [everOpened, setEverOpened] = useState(open);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  if (!everOpened) return null;

  return (
    <Suspense fallback={null}>
      <WatchDialogLazy {...props} />
    </Suspense>
  );
}
