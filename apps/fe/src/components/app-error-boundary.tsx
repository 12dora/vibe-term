// 应用级错误兜底：没有 errorElement 时 React Router 会把「Unexpected Application Error!」
// 那张开发者页面直接怼到用户脸上。这里统一换成一张可重试 / 重载 / 回首页的卡片，
// 错误详情折起来备查（带一键复制，方便用户把现场发回来）。
//
// 两种形态共用同一套文案与详情块：
//   page  —— 挂在根路由的 errorElement 上，整页替换；
//   panel —— 侧滑面板内部，出错只毁这块内容，页面其他部分照常可用。

import { formatDisplayVersion, writeTextToClipboard } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { AlertTriangle, Check, ChevronRight, Copy, Home, RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router';

// vite define 注入的构建期常量；单测里不存在，用 typeof 探测而不是直接引用。
const DISPLAY_VERSION =
  typeof __MONOREPO_VERSION__ === 'string'
    ? formatDisplayVersion(__MONOREPO_VERSION__, typeof __IS_PROD__ === 'boolean' && __IS_PROD__)
    : null;

export interface ErrorDetails {
  message: string;
  stack: string | null;
}

export function describeError(error: unknown): ErrorDetails {
  if (isRouteErrorResponse(error)) {
    const data = typeof error.data === 'string' && error.data ? ` — ${error.data}` : '';
    return { message: `${error.status} ${error.statusText}${data}`, stack: null };
  }
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? null };
  }
  if (typeof error === 'string') return { message: error, stack: null };
  return { message: safeStringify(error), stack: null };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 复制给用户的现场：错误信息 + 调用栈 + 版本 + 当前地址。 */
export function formatErrorDetails(details: ErrorDetails, url?: string): string {
  const lines = [details.message];
  if (details.stack) lines.push(details.stack);
  if (DISPLAY_VERSION) lines.push(`version: ${DISPLAY_VERSION}`);
  const href = url ?? (typeof window === 'undefined' ? null : window.location.href);
  if (href) lines.push(`url: ${href}`);
  return lines.join('\n');
}

function reloadApp(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

// 回首页走整页跳转而不是 router navigate：出错时坏掉的往往正是被渲染的模块，
// 客户端跳转只会把同一份坏状态再挂一次。
function goHome(): void {
  if (typeof window !== 'undefined') window.location.assign('/');
}

export interface AppErrorFallbackProps {
  error: unknown;
  variant?: 'page' | 'panel';
  onRetry: () => void;
  onClose?: () => void;
}

export function AppErrorFallback({
  error,
  variant = 'page',
  onRetry,
  onClose,
}: AppErrorFallbackProps) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const details = describeError(error);
  const panel = variant === 'panel';

  const copy = () => {
    void writeTextToClipboard(formatErrorDetails(details)).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <div
      role="alert"
      data-testid={panel ? 'panel-error' : 'app-error'}
      className={
        panel
          ? 'flex flex-1 items-start justify-center'
          : 'flex min-h-dvh items-center justify-center p-6'
      }
    >
      <Card size={panel ? 'sm' : 'default'} className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-500" />
            {t('appError.title')}
          </CardTitle>
          <CardDescription>
            {t(panel ? 'appError.panelDescription' : 'appError.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onRetry} data-testid="app-error-retry">
              <RotateCw />
              {t('appError.retry')}
            </Button>
            {panel ? null : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={reloadApp}
                  data-testid="app-error-reload"
                >
                  {t('appError.reload')}
                </Button>
                <Button size="sm" variant="ghost" onClick={goHome} data-testid="app-error-home">
                  <Home />
                  {t('appError.home')}
                </Button>
              </>
            )}
            {panel && onClose ? (
              <Button size="sm" variant="outline" onClick={onClose} data-testid="app-error-close">
                {t('appError.closePanel')}
              </Button>
            ) : null}
          </div>

          <div>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
              data-testid="app-error-details-toggle"
            >
              <ChevronRight
                className={`transition-transform duration-(--tmex-motion-fast) motion-reduce:transition-none ${detailsOpen ? 'rotate-90' : ''}`}
              />
              {t('appError.details')}
            </Button>
            {detailsOpen ? (
              <div className="mt-2 space-y-2" data-testid="app-error-details">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 font-mono text-[11px]">
                  {formatErrorDetails(details)}
                </pre>
                <Button variant="outline" size="xs" onClick={copy} data-testid="app-error-copy">
                  {copied ? (
                    <Check className="tmex-scale-in" />
                  ) : (
                    <Copy className="tmex-scale-in" />
                  )}
                  {copied ? t('appError.copied') : t('appError.copyDetails')}
                </Button>
              </div>
            ) : null}
          </div>

          {DISPLAY_VERSION ? (
            <p className="text-[11px] text-muted-foreground" data-testid="app-error-version">
              {t('appError.version', { version: DISPLAY_VERSION })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export interface AppErrorBoundaryProps {
  children: ReactNode;
  variant?: 'page' | 'panel';
  /** panel 形态下的「关闭面板」动作 */
  onClose?: () => void;
}

interface AppErrorBoundaryState {
  error: unknown;
  /** 重试代次：换 key 让子树整棵重挂，而不是复用已经出过错的实例 */
  attempt: number;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[app] render error', error, info.componentStack);
  }

  /** 清空错误并让子树整棵重挂（public：单测直接驱动这条状态迁移，无 DOM 点不了按钮） */
  readonly retry = (): void => {
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }));
  };

  render(): ReactNode {
    const { error, attempt } = this.state;
    if (error !== null && error !== undefined) {
      return (
        <AppErrorFallback
          error={error}
          variant={this.props.variant}
          onRetry={this.retry}
          onClose={this.props.onClose}
        />
      );
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}

/**
 * 根路由的 errorElement：loader / render 抛到路由层的错误都落在这里。
 * 重试重新导航到当前地址——data router 会在导航完成时清掉错误状态。
 */
export function RouteErrorElement() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    console.error('[app] route error', error);
  }, [error]);

  return (
    <AppErrorFallback
      error={error}
      onRetry={() => {
        void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true });
      }}
    />
  );
}
