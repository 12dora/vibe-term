// 远程访问状态卡：状态徽标、公网地址、启停 / 移除 / 连通性检查，以及可折叠的 cloudflared 日志。

import type { TunnelStatusResponse } from '@tmex/shared';
import { Badge } from '@tmex/ui/badge';
import { Button, buttonVariants } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { ExternalLink, Loader2, Play, Radar, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../nodes/copy-feedback';
import { SetupNotice } from '../nodes/setup/form-parts';
import { DetailRow } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { describeTunnelError, logTail, tunnelPill } from './tunnel-model';

const PILL_VARIANT = {
  notConfigured: 'outline',
  stopped: 'outline',
  starting: 'secondary',
  running: 'default',
  error: 'destructive',
} as const;

export function TunnelStatusCard({
  status,
  actions,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
}) {
  const { t } = useTranslation();
  const pill = tunnelPill(status);
  const configured = status.config.mode !== 'off';
  const stoppable = status.process.state === 'running' || status.process.state === 'starting';
  const { busy, pending } = actions;

  return (
    <Card data-testid="remote-access-status">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t('settings.remoteAccess.title')}
          <Badge variant={PILL_VARIANT[pill]} data-testid="remote-access-state">
            {t(`settings.remoteAccess.state.${pill}`)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {actions.error && (
          <SetupNotice tone="error" testId="remote-access-error">
            {describeTunnelError(t, actions.error)}
          </SetupNotice>
        )}

        {status.process.state === 'error' && status.process.lastError && (
          <SetupNotice tone="error" testId="remote-access-process-error">
            {status.process.lastError}
          </SetupNotice>
        )}

        {configured && (
          <div className="space-y-0.5 rounded-lg bg-muted/40 p-3">
            <DetailRow label={t('settings.remoteAccess.modeLabel')} testId="remote-access-mode">
              {t(`settings.remoteAccess.mode.${status.config.mode}.title`)}
            </DetailRow>
            {status.process.publicUrl && (
              <DetailRow label={t('settings.remoteAccess.publicUrl')}>
                <span className="flex flex-wrap items-center gap-1">
                  <code
                    className="min-w-0 break-all rounded bg-background px-1.5 py-0.5 font-mono text-[11px]"
                    data-testid="remote-access-public-url"
                  >
                    {status.process.publicUrl}
                  </code>
                  <CopyButton value={status.process.publicUrl} testId="remote-access-public-url" />
                  <a
                    className={buttonVariants({ size: 'xs', variant: 'ghost' })}
                    href={status.process.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="remote-access-open"
                  >
                    <ExternalLink />
                    {t('settings.remoteAccess.actions.open')}
                  </a>
                </span>
              </DetailRow>
            )}
            {status.process.restarts > 0 && (
              <DetailRow
                label={t('settings.remoteAccess.restartsLabel')}
                testId="remote-access-restarts"
              >
                {t('settings.remoteAccess.restarts', { times: status.process.restarts })}
              </DetailRow>
            )}
          </div>
        )}

        {configured && (
          <div className="flex flex-wrap gap-2">
            {!stoppable && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => actions.run({ action: 'start' })}
                data-testid="remote-access-start"
              >
                {pending === 'start' ? <Loader2 className="animate-spin" /> : <Play />}
                {t('settings.remoteAccess.actions.start')}
              </Button>
            )}
            {stoppable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => actions.run({ action: 'stop' })}
                data-testid="remote-access-stop"
              >
                {pending === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
                {t('settings.remoteAccess.actions.stop')}
              </Button>
            )}
            {status.process.state === 'running' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => actions.run({ action: 'check' })}
                data-testid="remote-access-check"
              >
                {pending === 'check' ? <Loader2 className="animate-spin" /> : <Radar />}
                {t('settings.remoteAccess.actions.check')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => actions.run({ action: 'remove' })}
              data-testid="remote-access-remove"
            >
              {pending === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('settings.remoteAccess.actions.remove')}
            </Button>
          </div>
        )}

        {actions.check && (
          <SetupNotice
            tone={actions.check.ok ? 'success' : 'error'}
            testId={actions.check.ok ? 'remote-access-check-ok' : 'remote-access-check-failed'}
          >
            <p>
              {actions.check.ok
                ? t('settings.remoteAccess.check.reachable')
                : t('settings.remoteAccess.check.unreachable')}
            </p>
            {actions.check.message && <p className="break-all">{actions.check.message}</p>}
          </SetupNotice>
        )}

        <TunnelLog log={status.log} />
      </CardContent>
    </Card>
  );
}

/**
 * 日志用 `<details>` 而不是受控折叠：内容始终在 DOM 里，展开时不必重挂，
 * 也让静态渲染的用例能直接断言到行内容。
 */
function TunnelLog({ log }: { log: string[] }) {
  const { t } = useTranslation();
  const lines = logTail(log);
  const lineCount = lines.length;
  const boxRef = useRef<HTMLPreElement | null>(null);

  // 新行永远追加在末尾：日志一变就贴到底，否则展开后看到的一直是最早那几行。
  useEffect(() => {
    const box = boxRef.current;
    if (box && lineCount > 0) box.scrollTop = box.scrollHeight;
  }, [lineCount]);

  return (
    <details data-testid="remote-access-log">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t('settings.remoteAccess.log.title')}
      </summary>
      {lineCount === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="remote-access-log-empty">
          {t('settings.remoteAccess.log.empty')}
        </p>
      ) : (
        <pre
          ref={boxRef}
          className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
          data-testid="remote-access-log-box"
        >
          {lines.join('\n')}
        </pre>
      )}
    </details>
  );
}
