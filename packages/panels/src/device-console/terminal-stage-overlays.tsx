// 终端显示区的占位与遮罩：主动断开 / 加载中 / 选择失效 / 快照解析中 / 设备连接中。
// 从 ./terminal-stage 拆出，DOM 结构被 e2e 依赖（data-testid 不要改名）。

import { Loader2, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DevicePaneSelection } from './use-device-pane-selection';

export function CenteredNotice({ children }: { children: ReactNode }) {
  return (
    <div className="vibeterm-fade absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-4">{children}</div>
    </div>
  );
}

export function LoadingPlaceholder() {
  const { t } = useTranslation();
  return (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin motion-reduce:animate-none" />
      </div>
      <h3 className="text-lg font-medium">{t('terminal.connecting')}</h3>
    </>
  );
}

export function DisconnectedPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" data-testid="device-disconnected-placeholder">
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <span className="text-2xl text-muted-foreground">🔌</span>
      </div>
      <h3 className="text-lg font-medium">{t('device.disconnected')}</h3>
      <p className="text-sm text-muted-foreground">{t('device.connectToStart')}</p>
    </div>
  );
}

export function IdlePlaceholder({ needsWindow }: { needsWindow: boolean }) {
  const { t } = useTranslation();
  if (!needsWindow) {
    return <LoadingPlaceholder />;
  }
  return (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <span className="text-2xl text-muted-foreground">📋</span>
      </div>
      <h3 className="text-lg font-medium">{t('window.noWindowSelected')}</h3>
      <p className="text-sm text-muted-foreground">{t('window.selectWindowToStart')}</p>
    </>
  );
}

export function InvalidSelectionNotice({ isWindowMissing, isPaneMissing }: DevicePaneSelection) {
  const { t } = useTranslation();
  const message = isWindowMissing
    ? t('terminal.windowClosed')
    : isPaneMissing
      ? t('terminal.paneClosed')
      : null;
  return (
    <CenteredNotice>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <SearchX className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="terminal-selection-invalid">
        {message}
      </p>
    </CenteredNotice>
  );
}

/** 已连接但快照尚未解析出该 pane：内容本就空白，用遮罩 spinner 表达 loading。 */
export function ResolvingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="vibeterm-fade absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
      data-testid="terminal-status-overlay"
    >
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
        <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin motion-reduce:animate-none" />
        <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
          {t('terminal.connecting')}
        </span>
      </div>
    </div>
  );
}

/**
 * pane id 已由本地拓扑给出、设备尚未连上：终端先挂起来（wasm / 订阅 / 首屏请求都能提前排队），
 * 内容为空的这段时间盖一层「连接中」。首个 ScreenBegin…Commit / SourceGap 会整屏重写。
 */
export function ConnectingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="vibeterm-fade pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm text-muted-foreground"
      data-testid="terminal-connecting-overlay"
    >
      {t('terminal.connecting')}
    </div>
  );
}
