// 远程访问状态卡：状态与 Access 徽标、公网地址、启停 / 移除 / 连通性检查，以及可折叠的 cloudflared 日志。

import type { TunnelStatusResponse } from '@tmex/shared';
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
import { Button, buttonVariants } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { ExternalLink, Loader2, Play, Radar, Square, Trash2, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../nodes/copy-feedback';
import { SetupNotice } from '../nodes/setup/form-parts';
import {
  EXPOSURE_ACK,
  type ExposureState,
  ExposureWarning,
  exposureAck,
  exposureShown,
} from './exposure';
import { DetailRow } from './step-shell';
import type { TunnelActions, TunnelCheckResult } from './tunnel-actions';
import {
  type TunnelPill,
  checkNotice,
  connectorState,
  describeTunnelError,
  isExposureAckError,
  logTail,
  protectionPill,
  tunnelPill,
} from './tunnel-model';

const PILL_VARIANT = {
  notConfigured: 'outline',
  stopped: 'outline',
  starting: 'secondary',
  running: 'default',
  degraded: 'destructive',
  error: 'destructive',
} as const;

const PROTECTION_PILL_VARIANT = {
  notConfigured: 'outline',
  // 「查不了」与「查过了没有」在语义上都不是保护，但要让用户看出差别：前者用中性底色。
  unknown: 'secondary',
  dashboardCovered: 'secondary',
  notEnforced: 'secondary',
  hostnameMismatch: 'secondary',
  protected: 'default',
  loginProtected: 'default',
  loginMissing: 'secondary',
  // 用户明确选了「无」：这是唯一一档「确实没有保护」，用最重的语气。
  unprotected: 'destructive',
} as const;

export function TunnelStatusCard({
  status,
  actions,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const pill = tunnelPill(status);
  const configured = status.config.mode !== 'off';
  const adopted = status.config.externallyManaged;
  const stoppable =
    status.process.state === 'running' ||
    status.process.state === 'starting' ||
    status.process.state === 'degraded';
  const { busy, pending } = actions;
  // 命名隧道的移除会连 Cloudflare 上的隧道一起删掉，不可撤销，必须二次确认。
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = () => actions.run({ action: 'remove' });
  const ackError = isExposureAckError(status, actions.error);
  const startable = configured && !adopted && !stoppable;
  // 确认只属于「启动」这一个动作：卡片顶部那条只是说明后端为什么拒了，不带勾选。
  const startAck = exposureAck(
    exposure,
    EXPOSURE_ACK.start,
    startable && exposureShown(exposure, 'compact')
  );

  return (
    <Card data-testid="remote-access-status">
      <StatusHeader status={status} pill={pill} adopted={adopted} />
      <CardContent className="space-y-3">
        {actions.error && !ackError && (
          <SetupNotice tone="error" testId="remote-access-error">
            {describeTunnelError(t, actions.error)}
          </SetupNotice>
        )}

        {/* 启动按钮旁那条警示已经带了确认勾选与「请先勾选」提示，这里不再重复一遍。 */}
        {ackError && !startAck.shown && (
          <ExposureWarning
            exposure={{ ...exposure, ackRequired: true }}
            testId="remote-access-status-exposure"
          />
        )}

        {status.process.state === 'error' && status.process.lastError && (
          <SetupNotice tone="error" testId="remote-access-process-error">
            {status.process.lastError}
          </SetupNotice>
        )}

        {pill === 'degraded' && <DegradedNotice status={status} />}

        {configured && (
          <div className="space-y-0.5 rounded-lg bg-muted/40 p-3">
            <DetailRow label={t('settings.remoteAccess.modeLabel')} testId="remote-access-mode">
              {t(`settings.remoteAccess.mode.${status.config.mode}.title`)}
            </DetailRow>
            {status.process.publicUrl && (
              <DetailRow label={t('settings.remoteAccess.publicUrl')}>
                <span className="flex flex-wrap items-center gap-1">
                  <code
                    className="-ml-1.5 min-w-0 break-all rounded bg-background px-1.5 py-0.5 font-mono text-[11px]"
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
            <ConnectorRow status={status} />
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

        {adopted && (
          <SetupNotice tone="info" testId="remote-access-managed-notice">
            {t('settings.remoteAccess.externallyManagedNotice')}
          </SetupNotice>
        )}

        {/* 接管来的隧道由系统服务拉起，tmex 这边的启停 / 移除会被后端 409 挡回来。 */}
        {startable && (
          <ExposureWarning
            exposure={exposure}
            ack={startAck}
            testId="remote-access-start-exposure"
            variant="compact"
          />
        )}

        {configured && (
          <div className="flex flex-wrap gap-2">
            {startable && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => startAck.submit(actions.run, { action: 'start' })}
                data-testid="remote-access-start"
              >
                {pending === 'start' ? <Loader2 className="animate-spin" /> : <Play />}
                {t('settings.remoteAccess.actions.start')}
              </Button>
            )}
            {!adopted && stoppable && (
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
            {(adopted || pill === 'running' || pill === 'degraded') && (
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
            {adopted ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={remove}
                data-testid="remote-access-release"
              >
                {pending === 'remove' ? <Loader2 className="animate-spin" /> : <Unplug />}
                {t('settings.remoteAccess.actions.release')}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => (status.config.mode === 'named' ? setConfirmRemove(true) : remove())}
                data-testid="remote-access-remove"
              >
                {pending === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {t('settings.remoteAccess.actions.remove')}
              </Button>
            )}
          </div>
        )}

        {actions.checking && (
          <SetupNotice tone="info" testId="remote-access-check-running">
            {t('settings.remoteAccess.check.running')}
          </SetupNotice>
        )}

        {actions.check && <CheckResultNotice check={actions.check} />}

        <TunnelLog log={status.log} externallyManaged={adopted} />
      </CardContent>
      <ConfirmRemoveDialog
        open={confirmRemove}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          remove();
        }}
      />
    </Card>
  );
}

/** 卡片标题上的三枚徽标：隧道状态、访问保护、是否由系统服务托管。 */
function StatusHeader({
  status,
  pill,
  adopted,
}: {
  status: TunnelStatusResponse;
  pill: TunnelPill;
  adopted: boolean;
}) {
  const { t } = useTranslation();
  const protection = protectionPill(status);
  return (
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center gap-2">
        {t('settings.remoteAccess.title')}
        <Badge variant={PILL_VARIANT[pill]} data-testid="remote-access-state">
          {t(`settings.remoteAccess.state.${pill}`)}
        </Badge>
        <Badge
          variant={PROTECTION_PILL_VARIANT[protection]}
          data-testid="remote-access-access-state"
        >
          {t(`settings.remoteAccess.accessState.${protection}`)}
        </Badge>
        {adopted && (
          <Badge variant="secondary" data-testid="remote-access-managed">
            {t('settings.remoteAccess.externallyManaged')}
          </Badge>
        )}
      </CardTitle>
    </CardHeader>
  );
}

/**
 * 进程在跑但没有边缘连接：公网地址此时是断的。进程与连接器各自的最近一条错误都值钱，
 * 拼在第二行给用户一个直接的排查线索。
 */
function DegradedNotice({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const detail = status.process.lastError ?? status.connector?.lastError ?? null;
  return (
    <SetupNotice tone="warning" testId="remote-access-degraded">
      <p>{t('settings.remoteAccess.degradedNotice')}</p>
      {detail && <p className="break-all">{detail}</p>}
    </SetupNotice>
  );
}

const CONNECTOR_CLASS = {
  connected: '',
  noConnections: 'text-destructive',
  unknown: 'text-muted-foreground',
  unprobed: 'text-muted-foreground',
} as const;

/** 连接器一行：边缘连接数是「公网地址还通不通」最直接的证据，metrics 地址塞进 title 不占版面。 */
function ConnectorRow({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const state = connectorState(status);
  const connector = status.connector;
  const text =
    state === 'connected'
      ? t('settings.remoteAccess.connector.connected', {
          n: connector?.readyConnections ?? 0,
        })
      : t(`settings.remoteAccess.connector.${state}`);
  return (
    <DetailRow label={t('settings.remoteAccess.connector.label')} testId="remote-access-connector">
      <span className={CONNECTOR_CLASS[state]} title={connector?.metricsAddr ?? undefined}>
        {text}
      </span>
    </DetailRow>
  );
}

/** 检查结论：成功 / 警示 / 失败三种语气由 `checkNotice` 决定，这里只负责渲染。 */
function CheckResultNotice({ check }: { check: TunnelCheckResult }) {
  const { t } = useTranslation();
  const notice = checkNotice(check);
  return (
    <SetupNotice tone={notice.tone} testId={notice.testId}>
      <p>{notice.message === null ? t(notice.key) : t(notice.key, { message: notice.message })}</p>
      {notice.detail && <p className="break-all">{notice.detail}</p>}
    </SetupNotice>
  );
}

/** 命名隧道的移除确认：停止隧道、删除本机凭证，并在 Cloudflare 删除该隧道。 */
function ConfirmRemoveDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="remote-access-confirm-remove">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.remoteAccess.confirmRemove.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">{t('settings.remoteAccess.confirmRemove.description')}</span>
            <span className="mt-2 block">
              {t('settings.remoteAccess.confirmRemove.irreversible')}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} data-testid="remote-access-confirm-remove-cancel">
            {t('settings.remoteAccess.confirmRemove.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid="remote-access-confirm-remove-confirm"
          >
            {t('settings.remoteAccess.confirmRemove.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 日志用 `<details>` 而不是受控折叠：内容始终在 DOM 里，展开时不必重挂，
 * 也让静态渲染的用例能直接断言到行内容。
 */
function TunnelLog({
  log,
  externallyManaged,
}: {
  log: string[];
  externallyManaged: boolean;
}) {
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
          {/* 外部 cloudflared 的输出只有 --logfile 才拿得到，空日志多半是启动参数没带它。 */}
          {t(`settings.remoteAccess.log.${externallyManaged ? 'emptyExternal' : 'empty'}`)}
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
