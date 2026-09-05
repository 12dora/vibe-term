// 分享弹窗按需加载：与 `deferred-watch-dialog` 同一套机制（显式 loader、失败不缓存、
// 有限次就地重试、兜底整页刷新），理由见那边的注释。工具栏侧另有空闲预热。

import { type ComponentType, useEffect, useState } from 'react';
import {
  MAX_SHEET_LOAD_RETRIES,
  TerminalSettingsFallback,
  type TerminalSettingsFallbackView,
} from '../device-console/deferred-terminal-settings-sheet';

export interface DeferredShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  windowId: string;
  defaultName: string;
  /** 测试注入点；默认整页刷新以重新拿到 index.html */
  reload?: () => void;
}

type ShareDialogComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  windowId: string;
  defaultName: string;
}>;

type ShareDialogImporter = () => Promise<{ ShareDialog: ShareDialogComponent }>;

const defaultImporter: ShareDialogImporter = () => import('./share-dialog');

let importShareDialog: ShareDialogImporter = defaultImporter;
let cachedDialog: ShareDialogComponent | null = null;
let inflight: Promise<ShareDialogComponent> | null = null;

export function loadShareDialog(): Promise<ShareDialogComponent> {
  if (cachedDialog) return Promise.resolve(cachedDialog);
  if (!inflight) {
    inflight = importShareDialog().then(
      (module) => {
        cachedDialog = module.ShareDialog;
        inflight = null;
        return module.ShareDialog;
      },
      (error: unknown) => {
        inflight = null;
        throw error;
      }
    );
  }
  return inflight;
}

/** 仅供测试：替换动态 import，并清掉模块级缓存 */
export function setShareDialogImporterForTests(importer: ShareDialogImporter | null): void {
  importShareDialog = importer ?? defaultImporter;
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
export function schedulePreloadShareDialog(
  enabled: boolean,
  schedule: IdleScheduler = scheduleIdle
): () => void {
  if (!enabled) return () => undefined;
  return schedule(() => {
    void loadShareDialog().catch(() => undefined);
  });
}

export function useShareDialogPreload(enabled: boolean): void {
  useEffect(() => schedulePreloadShareDialog(enabled), [enabled]);
}

export function shareDialogFallbackView(failureCount: number): TerminalSettingsFallbackView | null {
  if (failureCount <= 0) return null;
  return {
    role: 'alert',
    messageKey: 'share.dialog.loadFailed',
    hintKey: 'settings.terminal.loadFailedHint',
    showRetry: failureCount < MAX_SHEET_LOAD_RETRIES,
    showReload: true,
  };
}

export function DeferredShareDialog({
  open,
  onOpenChange,
  deviceId,
  windowId,
  defaultName,
  reload = () => window.location.reload(),
}: DeferredShareDialogProps) {
  const [Dialog, setDialog] = useState<ShareDialogComponent | null>(() => cachedDialog);
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
    void loadShareDialog().then(
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
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        deviceId={deviceId}
        windowId={windowId}
        defaultName={defaultName}
      />
    );
  }
  if (!open) return null;

  const view = shareDialogFallbackView(failureCount);
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
