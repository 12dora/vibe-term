// 终端显示区的占位与遮罩：主动断开 / 加载中 / 选择失效 / 快照解析中 / 设备连接中。
// 从 ./terminal-stage 拆出，DOM 结构被 e2e 依赖（data-testid 不要改名）。

import { useRuntime, useTmuxStore } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { type ConnectionState, isNodeLinkFailureClose } from '@vibeterm/ws-client';
import { Loader2, RefreshCcw, SearchX } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
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

/** 「连接设备...」挂了这么久还没连上就补一行现状与重试（与连接按钮的超时同一口径）。 */
export const CONNECTING_OVERLAY_DEADLINE_MS = 8_000;

/**
 * 超时后那一行说什么：按节点 WS 的当前状态区分「还在连节点」「断了在重连」「节点通了、设备没回」；
 * 上一次是入口以「到不了该节点」的原因关掉的（1011 + 链路类 reason），明说「当前入口连接不了该节点」。
 */
export function connectingStalledKey(
  state: ConnectionState,
  lastCloseCode: number | null = null,
  lastCloseReason: string | null = null
): string {
  if (state === 'READY') return 'terminal.connectingStalled.device';
  if (isNodeLinkFailureClose(lastCloseCode, lastCloseReason))
    return 'terminal.connectingStalled.unreachable';
  if (state === 'RECONNECT_BACKOFF' || state === 'CLOSED') {
    return 'terminal.connectingStalled.reconnecting';
  }
  return 'terminal.connectingStalled.node';
}

function useDeadlinePassed(ms: number): boolean {
  const [passed, setPassed] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return passed;
}

function ConnectingStalledHint() {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const state = useTmuxStore((s) => s.connectionState);
  return (
    <div
      className="pointer-events-auto flex flex-col items-center gap-2 text-xs"
      data-testid="terminal-connecting-stalled"
    >
      <p>
        {t(
          connectingStalledKey(state, runtime.client.lastCloseCode, runtime.client.lastCloseReason)
        )}
      </p>
      <Button
        variant="outline"
        size="sm"
        data-testid="terminal-connecting-retry"
        onClick={() => runtime.client.reconnect()}
      >
        <RefreshCcw className="size-4" />
        {t('websocket.reconnect')}
      </Button>
    </div>
  );
}

/**
 * pane id 已由本地拓扑给出、设备尚未连上：终端先挂起来（wasm / 订阅 / 首屏请求都能提前排队），
 * 内容为空的这段时间盖一层「连接中」。首个 ScreenBegin…Commit / SourceGap 会整屏重写。
 * 转发 WS 一直连不上时这层不会自己消失，过了期限补一行现状与「重新连接」。
 */
export function ConnectingOverlay({
  deadlineMs = CONNECTING_OVERLAY_DEADLINE_MS,
}: {
  deadlineMs?: number;
}) {
  const { t } = useTranslation();
  const overdue = useDeadlinePassed(deadlineMs);
  return (
    <div
      className="vibeterm-fade pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/60 p-4 text-center text-sm text-muted-foreground"
      data-testid="terminal-connecting-overlay"
    >
      <span>{t('terminal.connecting')}</span>
      {overdue ? <ConnectingStalledHint /> : null}
    </div>
  );
}
