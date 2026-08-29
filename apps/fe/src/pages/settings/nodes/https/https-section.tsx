// 设置页「节点」标签里的 HTTPS 区块：外部反代 / 自签私有 CA / Let's Encrypt 三选一（外加关闭）。
//
// 所有角色都要看到它——standalone 想变 hub 就得先有 https 的公开地址，node 也可能被别人访问。
// 区块只负责编排：状态查询、模式选择、保存 / 续签的挂起态与错误提示，具体表单在各 panel 里。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { type TlsApi, defaultTlsApi } from '@tmex/api-client/local/tls-api';
import type {
  TlsMode,
  TlsStatusResponse,
  TlsUpdateRequest,
} from '@tmex/api-client/local/tls-types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useRestartGateway } from '../restart/use-restart-now';
import { AcmePanel } from './acme-panel';
import { ExternalPanel } from './external-panel';
import { ModeChooser } from './mode-chooser';
import { InfoRow, Notice } from './parts';
import { SelfSignedPanel } from './selfsigned-panel';
import { describeTlsError } from './tls-errors';
import { daysUntil, defaultSans, formatTimestamp } from './tls-form';
import { type TlsMutationKind, useTlsMutations } from './tls-mutations';
import { useTlsStatus } from './use-tls-status';

export interface HttpsSectionProps {
  api?: TlsApi;
  client?: ApiClient;
  /** 测试注入；默认读地址栏。 */
  hostname?: string | null;
  /** standalone 下额外提示：hub 公开地址必须是 https。 */
  showHubUrlHint?: boolean;
}

function browserHostname(): string | null {
  if (typeof window === 'undefined') return null;
  const hostname = window.location?.hostname;
  return typeof hostname === 'string' && hostname ? hostname : null;
}

export function HttpsSection({
  api = defaultTlsApi,
  client = defaultApiClient,
  hostname,
  showHubUrlHint = false,
}: HttpsSectionProps) {
  const { t } = useTranslation();
  const tls = useTlsStatus(api);
  const [draftMode, setDraftMode] = useState<TlsMode | null>(null);
  const restart = useRestartGateway(client, tls.refresh);

  const { setStatus, refresh } = tls;
  const mutations = useTlsMutations(api, tls.status, {
    onStatus: (next) => {
      setStatus(next);
      setDraftMode(next.mode);
    },
    onRefresh: refresh,
    onSaved: () => toast.success(t('nodes.https.saved')),
    onRenewStarted: () => toast.success(t('nodes.https.renewStarted')),
    onError: (err) => toast.error(describeTlsError(t, err)),
  });

  const body = (() => {
    if (tls.loginRequired) {
      return (
        <p className="text-xs text-muted-foreground" data-testid="https-login-required">
          {t('nodes.https.loginRequired')}
        </p>
      );
    }
    if (tls.loading) {
      return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
    }
    if (!tls.status) {
      return (
        <Notice tone="error" testId="https-load-failed">
          <p>{tls.error ?? t('nodes.https.loadFailed')}</p>
        </Notice>
      );
    }
    return (
      <HttpsBody
        status={tls.status}
        mode={draftMode ?? tls.status.mode}
        hostname={hostname === undefined ? browserHostname() : hostname}
        caUrl={api.caDownloadUrl()}
        busy={mutations.busy}
        pending={mutations.pending}
        restartLabel={
          restart.state === 'waiting'
            ? t('nodes.https.restarting')
            : restart.state === 'timeout'
              ? t('nodes.https.restartTimeout')
              : t('nodes.https.restartRequired')
        }
        restartWaiting={restart.waiting}
        onRestart={() => void restart.run()}
        onSelectMode={setDraftMode}
        onSave={mutations.requestSave}
        onRenew={mutations.renew}
      />
    );
  })();

  return (
    <Card data-testid="https-section">
      <CardHeader>
        <CardTitle>{t('nodes.https.title')}</CardTitle>
        <CardDescription>{t('nodes.https.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showHubUrlHint && (
          <p className="text-xs text-muted-foreground" data-testid="https-hub-url-hint">
            {t('nodes.https.hubUrlHint')}
          </p>
        )}
        {body}
      </CardContent>
      <StopListenerConfirm
        request={mutations.confirming}
        status={tls.status}
        onConfirm={mutations.confirmSave}
        onCancel={mutations.cancelSave}
      />
    </Card>
  );
}

/**
 * 停掉正在服务的 https 监听前必须二次确认：明文端口虽然还在，但远程管理员未必在防火墙 /
 * 路由器上放行过它——保存下去很可能当场把自己关在门外。
 */
function StopListenerConfirm({
  request,
  status,
  onConfirm,
  onCancel,
}: {
  request: TlsUpdateRequest | null;
  status: TlsStatusResponse | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!request) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent data-testid="https-confirm-stop">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.https.confirmStop.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">
              {t('nodes.https.confirmStop.description', {
                port: status?.listener.port ?? status?.tlsPort ?? '',
                mode: t(`nodes.https.mode.${request.mode}.title`),
              })}
            </span>
            <span className="mt-2 block">{t('nodes.https.confirmStop.requirement')}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} data-testid="https-confirm-stop-cancel">
            {t('nodes.https.confirmStop.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid="https-confirm-stop-confirm"
          >
            {t('nodes.https.confirmStop.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HttpsBody({
  status,
  mode,
  hostname,
  caUrl,
  busy,
  pending,
  restartLabel,
  restartWaiting,
  onRestart,
  onSelectMode,
  onSave,
  onRenew,
}: {
  status: TlsStatusResponse;
  mode: TlsMode;
  hostname: string | null;
  caUrl: string;
  /** 一把锁：保存、续签、ACME 后台签发期间所有模式与表单控件都禁用。 */
  busy: boolean;
  pending: TlsMutationKind | null;
  restartLabel: string;
  restartWaiting: boolean;
  onRestart: () => void;
  onSelectMode: (mode: TlsMode) => void;
  onSave: (req: TlsUpdateRequest) => void;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  const initialSans = defaultSans(hostname);
  const savePending = pending === 'save';
  const renewPending = pending === 'renew';
  return (
    <>
      <StatusHeader status={status} />

      {status.restartRequired && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="https-restart-required"
        >
          <span>{restartLabel}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={restartWaiting}
            onClick={onRestart}
            data-testid="https-restart-now"
          >
            {restartWaiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {t('nodes.https.restartNow')}
          </Button>
        </div>
      )}

      <ModeChooser selected={mode} active={status.mode} disabled={busy} onSelect={onSelectMode} />

      {mode === 'none' && (
        <div className="space-y-3" data-testid="https-none-panel">
          <p className="text-xs text-muted-foreground">{t('nodes.https.mode.none.detail')}</p>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => onSave({ mode: 'none' })}
              data-testid="https-none-save"
            >
              {savePending ? <Loader2 className="animate-spin" /> : <Save />}
              {t('nodes.https.save')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'external' && (
        <ExternalPanel
          key={`external:${status.mode}`}
          status={status}
          busy={busy}
          savePending={savePending}
          onSave={(trustProxy) => onSave({ mode: 'external', trustProxy })}
        />
      )}

      {mode === 'selfsigned' && (
        <SelfSignedPanel
          key={`selfsigned:${status.mode}`}
          status={status}
          initialSans={initialSans}
          caUrl={caUrl}
          busy={busy}
          savePending={savePending}
          renewPending={renewPending}
          onSave={(draft) => onSave({ mode: 'selfsigned', ...draft })}
          onRenew={onRenew}
        />
      )}

      {mode === 'acme' && (
        <AcmePanel
          key={`acme:${status.mode}`}
          status={status}
          defaultDomain={initialSans[0] ?? ''}
          busy={busy}
          savePending={savePending}
          renewPending={renewPending}
          onSave={(draft) => onSave({ mode: 'acme', ...draft })}
          onRenew={onRenew}
        />
      )}
    </>
  );
}

function StatusHeader({ status }: { status: TlsStatusResponse }) {
  const { t } = useTranslation();
  const cert = status.certificate;
  const listener = status.listener;
  const remaining = cert ? daysUntil(cert.notAfter) : null;

  return (
    <div className="space-y-1.5 rounded-lg bg-muted/40 p-3" data-testid="https-status-header">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('nodes.https.currentMode')}</span>
        <Badge variant="secondary" data-testid="https-current-mode">
          {t(`nodes.https.mode.${status.mode}.title`)}
        </Badge>
        {listener.error ? (
          <Badge variant="destructive" data-testid="https-listener-state">
            {t('nodes.https.listener.failed', { error: listener.error })}
          </Badge>
        ) : listener.running ? (
          <Badge variant="outline" data-testid="https-listener-state">
            {t('nodes.https.listener.running', { port: listener.port ?? status.tlsPort })}
          </Badge>
        ) : (
          <Badge variant="outline" data-testid="https-listener-state">
            {t('nodes.https.listener.stopped')}
          </Badge>
        )}
      </div>

      {cert ? (
        <div className="space-y-0.5" data-testid="https-certificate">
          <InfoRow label={t('nodes.https.certificate.subject')} testId="https-cert-subject">
            <span className="font-mono">{cert.subject}</span>
          </InfoRow>
          <InfoRow label={t('nodes.https.certificate.sans')} testId="https-cert-sans">
            <span className="font-mono">{cert.sans.join(', ') || '—'}</span>
          </InfoRow>
          <InfoRow label={t('nodes.https.certificate.issuer')} testId="https-cert-issuer">
            <span className="font-mono">{cert.issuer}</span>
          </InfoRow>
          <InfoRow label={t('nodes.https.certificate.validUntil')} testId="https-cert-valid-until">
            {formatTimestamp(cert.notAfter)}
            <span
              className={`ml-1 ${remaining !== null && remaining < 0 ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {remaining !== null && remaining < 0
                ? t('nodes.https.certificate.expired')
                : t('nodes.https.certificate.daysLeft', { days: remaining ?? 0 })}
            </span>
          </InfoRow>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="https-no-certificate">
          {t('nodes.https.certificate.none')}
        </p>
      )}
    </div>
  );
}
