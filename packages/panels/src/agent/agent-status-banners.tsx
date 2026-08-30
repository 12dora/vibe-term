import { useTranslation } from 'react-i18next';

import { Button } from '@tmex/ui/button';
import { CircleAlertIcon } from 'lucide-react';

/** 节点离线 / 孤立会话 / pane 绑定不一致 / 运行错误四条状态横幅 */
export function AgentStatusBanners({
  isOrphan,
  showNodeOffline,
  showPaneMismatch,
  bindingValid,
  canRebind,
  errorText,
  retryText,
  sending,
  onGoToBinding,
  onRebind,
  onRetry,
}: {
  isOrphan: boolean;
  showNodeOffline: boolean;
  showPaneMismatch: boolean;
  bindingValid: boolean;
  canRebind: boolean;
  errorText: string | null;
  retryText: string | null;
  sending: boolean;
  onGoToBinding: () => void;
  onRebind: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {showNodeOffline && (
        <div
          data-testid="agent-node-offline-banner"
          className="bg-muted/50 text-muted-foreground mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t('agent.node.offlinePaused')}</span>
        </div>
      )}

      {isOrphan && (
        <div
          data-testid="agent-orphan-banner"
          className="bg-muted/50 text-muted-foreground mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t('agent.orphan.readonly')}</span>
        </div>
      )}

      {showPaneMismatch && (
        <div
          data-testid="agent-pane-mismatch"
          className="bg-muted/50 mx-3 mb-1.5 flex shrink-0 flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1">
            {t('agent.binding.mismatchTitle')}
          </span>
          {bindingValid && (
            <Button
              data-testid="agent-binding-goto"
              size="xs"
              variant="outline"
              onClick={onGoToBinding}
            >
              {t('agent.binding.goTo')}
            </Button>
          )}
          {canRebind && (
            <Button
              data-testid="agent-binding-rebind"
              size="xs"
              variant="outline"
              onClick={onRebind}
            >
              {t('agent.binding.rebind')}
            </Button>
          )}
        </div>
      )}

      {errorText && (
        <div
          data-testid="agent-error-banner"
          className="bg-destructive/10 text-destructive mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{errorText}</span>
          {retryText && !isOrphan && (
            <Button
              data-testid="agent-error-retry"
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={sending}
              onClick={onRetry}
            >
              {t('agent.panel.retry')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
