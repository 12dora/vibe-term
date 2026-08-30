// 终端设置面板按需加载：打开时才拉 chunk。
//
// 应用没有 Service Worker，只有 webmanifest。iOS 主屏 PWA 的 standalone webview 会顽固地
// 缓存启动页：服务端升级后，缓存的 index.html 仍指向旧 hash 的 chunk URL，那些文件已经不
// 存在，动态 import 会一直 404。浏览器还会把失败的模块 URL 记进 module map，就地重试拿到
// 的是同一条失败记录——只有重新取 index.html（整页刷新）才能指到新版 chunk。
// 参考 apps/fe 的 lazyChunk：有限次就地重试 + 兜底整页刷新，这里额外做两件事：
//   1) 工具栏挂载后空闲预热 chunk，趁当前 index 还新鲜时就把它拉下来，多数情况下直接绕开
//      失败窗口，顺带让面板离线可用；
//   2) 兜底条从第一次失败起就给出「重新加载应用」，并解释多半是发布了新版本。

import { Button } from '@tmex/ui/button';
import { type ComponentType, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type TerminalSettingsSheetComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

/** 就地重试上限，超过后兜底条只留整页刷新 */
export const MAX_SHEET_LOAD_RETRIES = 2;

// 模块级缓存：预热成功后再打开面板不再走 loading 态；失败不缓存，重试要能重新发起 import。
let cachedSheet: TerminalSettingsSheetComponent | null = null;
let inflight: Promise<TerminalSettingsSheetComponent> | null = null;

export function loadTerminalSettingsSheet(): Promise<TerminalSettingsSheetComponent> {
  if (cachedSheet) return Promise.resolve(cachedSheet);
  if (!inflight) {
    inflight = import('../settings/terminal-settings-sheet').then(
      (module) => {
        cachedSheet = module.TerminalSettingsSheet;
        inflight = null;
        return module.TerminalSettingsSheet;
      },
      (error: unknown) => {
        inflight = null;
        throw error;
      }
    );
  }
  return inflight;
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

/** 首帧之后空闲预热终端设置 chunk；预热失败静默，真正打开面板时再走兜底条。 */
export function useTerminalSettingsPreload(): void {
  useEffect(
    () =>
      scheduleIdle(() => {
        void loadTerminalSettingsSheet().catch(() => undefined);
      }),
    []
  );
}

export interface TerminalSettingsFallbackView {
  role: 'alert' | 'status';
  messageKey: string;
  /** 失败时的补充说明：多半是发布了新版本 */
  hintKey?: string;
  showRetry: boolean;
  showReload: boolean;
}

export function terminalSettingsFallbackView(failureCount: number): TerminalSettingsFallbackView {
  if (failureCount <= 0) {
    return {
      role: 'status',
      messageKey: 'settings.terminal.loading',
      showRetry: false,
      showReload: false,
    };
  }
  return {
    role: 'alert',
    messageKey: 'settings.terminal.loadFailed',
    hintKey: 'settings.terminal.loadFailedHint',
    showRetry: failureCount < MAX_SHEET_LOAD_RETRIES,
    showReload: true,
  };
}

interface TerminalSettingsFallbackProps {
  view: TerminalSettingsFallbackView;
  onRetry: () => void;
  onReload: () => void;
  onClose: () => void;
}

export function TerminalSettingsFallback({
  view,
  onRetry,
  onReload,
  onClose,
}: TerminalSettingsFallbackProps) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background px-4 py-5 text-sm shadow-lg"
      role={view.role}
      aria-live="polite"
      data-testid="terminal-settings-fallback"
    >
      <div className="mx-auto flex max-w-md flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 flex-1">
          {t(view.messageKey)}
          {view.hintKey && (
            <span className="mt-1 block text-xs text-muted-foreground">{t(view.hintKey)}</span>
          )}
        </span>
        <div className="flex shrink-0 gap-2">
          {view.showRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              data-testid="terminal-settings-retry"
            >
              {t('common.retry')}
            </Button>
          )}
          {view.showReload && (
            <Button
              variant="default"
              size="sm"
              onClick={onReload}
              data-testid="terminal-settings-reload"
            >
              {t('settings.terminal.reloadApp')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface DeferredTerminalSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 测试注入点；默认整页刷新以重新拿到 index.html */
  reload?: () => void;
}

export function DeferredTerminalSettingsSheet({
  open,
  onOpenChange,
  reload = () => window.location.reload(),
}: DeferredTerminalSettingsSheetProps) {
  const [SheetComponent, setSheetComponent] = useState<TerminalSettingsSheetComponent | null>(
    () => cachedSheet
  );
  const [failureCount, setFailureCount] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is an explicit retry trigger
  useEffect(() => {
    if (!open || SheetComponent) return;
    let cancelled = false;
    void loadTerminalSettingsSheet().then(
      (component) => {
        if (!cancelled) setSheetComponent(() => component);
      },
      () => {
        if (!cancelled) setFailureCount((count) => count + 1);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, open, SheetComponent]);

  if (SheetComponent) {
    return <SheetComponent open={open} onOpenChange={onOpenChange} />;
  }
  if (!open) return null;

  return (
    <TerminalSettingsFallback
      view={terminalSettingsFallbackView(failureCount)}
      onRetry={() => setLoadAttempt((value) => value + 1)}
      onReload={reload}
      onClose={() => onOpenChange(false)}
    />
  );
}
