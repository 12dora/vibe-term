// 监视规则对话框按需加载。
//
// WatchDialog 拖着一整棵表单树（规则列表 / 规则表单 / LLM 字段 / 正则字段 / 调度字段 /
// 状态视图，约 1.4 K 行），却被两条静态边钉在首屏 chunk 上：常驻侧栏的
// `device-tree-dialogs` 与控制台工具栏的 `page-actions`。它是模态框，不打开不渲染，
// 首屏一个字节都用不上。这里只保留「打开过才挂载」的边界，行为与直接渲染一致。
//
// 不用 `React.lazy`：它把 reject 永久缓存成 Rejected 并在渲染期一直抛，而 `Suspense`
// **接不住**异常，整条路由会被这个错误替换掉；重挂同一个组件读到的还是那条失败记录。
// 发版后旧 index.html 指向的 chunk 已经不存在（iOS 主屏 PWA 尤其顽固地缓存启动页），
// import() 就是 404——这不是理论风险。改成与 `deferred-terminal-settings-sheet` 同一套
// 机制：显式 loader（失败不缓存）+ 有限次就地重试 + 兜底整页刷新，兜底条直接复用那边的
// `TerminalSettingsFallback`（它只认 view 对象，本身与终端设置无关）。
// 控制台侧另有 `useWatchDialogPreload` 在空闲时预热，趁当前 index 还新鲜先把 chunk 拉下来。

import { type ComponentType, useEffect, useState } from 'react';
import {
  MAX_SHEET_LOAD_RETRIES,
  TerminalSettingsFallback,
  type TerminalSettingsFallbackView,
} from '../device-console/deferred-terminal-settings-sheet';

export interface DeferredWatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
  /** 测试注入点；默认整页刷新以重新拿到 index.html */
  reload?: () => void;
}

type WatchDialogComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
}>;

type WatchDialogImporter = () => Promise<{ WatchDialog: WatchDialogComponent }>;

const defaultImporter: WatchDialogImporter = () => import('./watch-dialog');

let importWatchDialog: WatchDialogImporter = defaultImporter;
// 模块级缓存：预热成功后再打开对话框不再走加载态；失败不缓存，重试要能重新发起 import。
let cachedDialog: WatchDialogComponent | null = null;
let inflight: Promise<WatchDialogComponent> | null = null;

export function loadWatchDialog(): Promise<WatchDialogComponent> {
  if (cachedDialog) return Promise.resolve(cachedDialog);
  if (!inflight) {
    inflight = importWatchDialog().then(
      (module) => {
        cachedDialog = module.WatchDialog;
        inflight = null;
        return module.WatchDialog;
      },
      (error: unknown) => {
        inflight = null;
        throw error;
      }
    );
  }
  return inflight;
}

/** 预取对话框 chunk；成功后 `DeferredWatchDialog` 首帧就能直接渲染真正的对话框。 */
export function preloadWatchDialog(): Promise<unknown> {
  return loadWatchDialog();
}

/** 仅供测试：替换动态 import，并清掉模块级缓存 */
export function setWatchDialogImporterForTests(importer: WatchDialogImporter | null): void {
  importWatchDialog = importer ?? defaultImporter;
  cachedDialog = null;
  inflight = null;
}

type IdleScheduler = (run: () => void) => () => void;

const scheduleIdle: IdleScheduler = (run) => {
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(run, { timeout: 3000 });
    return () => globalThis.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 1200);
  return () => clearTimeout(timer);
};

/** 关掉时一次调度都不排；返回取消函数供 effect 清理 */
export function schedulePreloadWatchDialog(
  enabled: boolean,
  schedule: IdleScheduler = scheduleIdle
): () => void {
  if (!enabled) return () => undefined;
  return schedule(() => {
    void preloadWatchDialog().catch(() => undefined);
  });
}

/**
 * 首帧之后空闲预热监视对话框 chunk；失败静默，真正打开时再走一次 import 与兜底条。
 *
 * `enabled` 必须与「按钮到底渲不渲染」同一个条件：功能关掉时按钮根本不存在，预热就是白白
 * 唤醒一次网络、下一段字节和一次解析。
 */
export function useWatchDialogPreload(enabled: boolean): void {
  useEffect(() => schedulePreloadWatchDialog(enabled), [enabled]);
}

/** 加载失败时的兜底条；未失败返回 null（模态框没打开就该什么都不显示） */
export function watchDialogFallbackView(failureCount: number): TerminalSettingsFallbackView | null {
  if (failureCount <= 0) return null;
  return {
    role: 'alert',
    messageKey: 'watch.rules.loadFailed',
    hintKey: 'settings.terminal.loadFailedHint',
    showRetry: failureCount < MAX_SHEET_LOAD_RETRIES,
    showReload: true,
  };
}

/**
 * 只有「被打开过」才挂载真正的对话框：`open` 首次为真时才发起 import，关闭后保持挂载，
 * 与原先直接渲染 `WatchDialog` 的开合语义一致。加载期间渲染 null——模态框本来就没有
 * 占位可言，出现得晚一帧不影响任何既有交互；加载失败才给兜底条。
 */
export function DeferredWatchDialog({
  open,
  onOpenChange,
  deviceId,
  paneId,
  reload = () => window.location.reload(),
}: DeferredWatchDialogProps) {
  const [Dialog, setDialog] = useState<WatchDialogComponent | null>(() => cachedDialog);
  const [failureCount, setFailureCount] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [everOpened, setEverOpened] = useState(open);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is an explicit retry trigger
  useEffect(() => {
    if (!everOpened || Dialog) return;
    let cancelled = false;
    void loadWatchDialog().then(
      (component) => {
        if (!cancelled) setDialog(() => component);
      },
      () => {
        if (!cancelled) setFailureCount((count) => count + 1);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, everOpened, Dialog]);

  if (Dialog) {
    return <Dialog open={open} onOpenChange={onOpenChange} deviceId={deviceId} paneId={paneId} />;
  }
  if (!open) return null;

  const view = watchDialogFallbackView(failureCount);
  if (!view) return null;

  return (
    <TerminalSettingsFallback
      view={view}
      onRetry={() => setLoadAttempt((value) => value + 1)}
      onReload={reload}
      onClose={() => onOpenChange(false)}
    />
  );
}
