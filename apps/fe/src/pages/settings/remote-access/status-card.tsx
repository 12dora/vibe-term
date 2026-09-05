// 远程访问状态卡：状态与 Access 徽标、公网地址、启停 / 移除 / 连通性检查，以及可折叠的 cloudflared 日志。

import type { TunnelStatusResponse } from '@tmex/shared';
import { Badge } from '@tmex/ui/badge';
import { Button, buttonVariants } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { ExternalLink, Loader2, Play, Radar, Square, Trash2, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DangerConfirmDialog } from '../components/danger-confirm-dialog';
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
  degradedError,
  describeTunnelError,
  edgeDiagnosis,
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
        <TunnelStatusNotices
          status={status}
          actions={actions}
          exposure={exposure}
          pill={pill}
          ackError={ackError}
          startAckShown={startAck.shown}
        />

        {configured && <TunnelDetails status={status} />}

        {adopted && (
          <SetupNotice tone="info" testId="remote-access-managed-notice">
            {t('settings.remoteAccess.externallyManagedNotice')}
          </SetupNotice>
        )}

        {/* 接管来的隧道由系统服务拉起，tmex 这边的启停 / 移除会被后端 409 挡回来。 */}
        {startAck.shown && (
          <ExposureWarning
            exposure={exposure}
            ack={startAck}
            testId="remote-access-start-exposure"
            variant="compact"
          />
        )}

        {configured && (
          <TunnelStatusActions
            status={status}
            actions={actions}
            pill={pill}
            adopted={adopted}
            startable={startable}
            stoppable={stoppable}
            onStart={() => startAck.submit(actions.run, { action: 'start' })}
            onRemove={remove}
            onConfirmRemove={() => setConfirmRemove(true)}
          />
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

/**
 * 动作按钮行。「移除」在命名隧道下先弹二次确认（会连 Cloudflare 上的隧道一起删），
 * 接管来的隧道只能「释放」——启停由系统服务管，tmex 这边发过去会被后端 409 挡回来。
 */
function TunnelStatusActions({
  status,
  actions,
  pill,
  adopted,
  startable,
  stoppable,
  onStart,
  onRemove,
  onConfirmRemove,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  pill: TunnelPill;
  adopted: boolean;
  startable: boolean;
  stoppable: boolean;
  onStart: () => void;
  onRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const { t } = useTranslation();
  const { busy, pending } = actions;
  return (
    <div className="flex flex-wrap gap-2">
      {startable && (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={onStart}
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
          onClick={onRemove}
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
          onClick={() => (status.config.mode === 'named' ? onConfirmRemove() : onRemove())}
          data-testid="remote-access-remove"
        >
          {pending === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {t('settings.remoteAccess.actions.remove')}
        </Button>
      )}
    </div>
  );
}

/**
 * 卡片顶部的四条提示，按优先级排开：动作报错、暴露确认、进程最近一条错误、降级说明。
 * 暴露确认只在「启动按钮旁那条」没出现时才补一条，避免同一句话说两遍。
 */
function TunnelStatusNotices({
  status,
  actions,
  exposure,
  pill,
  ackError,
  startAckShown,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
  pill: TunnelPill;
  ackError: boolean;
  startAckShown: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {actions.error && !ackError && (
        <SetupNotice tone="error" testId="remote-access-error">
          {describeTunnelError(t, actions.error)}
        </SetupNotice>
      )}

      {ackError && !startAckShown && (
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
    </>
  );
}

/** 已配置隧道时的明细块：方式、公网地址、连接器、边缘解析与重启次数。 */
function TunnelDetails({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  return (
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
      <EdgeRow status={status} />
      {status.process.restarts > 0 && (
        <DetailRow label={t('settings.remoteAccess.restartsLabel')} testId="remote-access-restarts">
          {t('settings.remoteAccess.restarts', { times: status.process.restarts })}
        </DetailRow>
      )}
    </div>
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
 * 进程在跑但没有边缘连接：公网地址此时是断的。排查指引按诊断结果分档（见 `DegradedHint`），
 * 进程 / 连接器 / 边缘解析各自的最近一条错误接在末尾，作为直接线索。
 */
function DegradedNotice({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const detail = degradedError(status);
  return (
    <SetupNotice tone="warning" testId="remote-access-degraded">
      <p>{t('settings.remoteAccess.degradedNotice')}</p>
      <DegradedHint status={status} />
      {detail && (
        <p
          className="break-all font-mono text-muted-foreground"
          data-testid="remote-access-degraded-error"
        >
          {detail}
        </p>
      )}
    </SetupNotice>
  );
}

/**
 * 排查指引三档：解析被 fake-IP 劫持且没绕开时给出代理侧的具体改法；已绕开则只说明当前走的是
 * 真实边缘地址（问题另有原因）；其余情况沿用通用的 7844 指引，且只在确证零连接时才给。
 */
function DegradedHint({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const diagnosis = edgeDiagnosis(status);

  if (diagnosis === 'bypassFailed') {
    return (
      <>
        <p data-testid="remote-access-edge-fakeip">
          {t('settings.remoteAccess.edge.bypassFailed')}
        </p>
        <p data-testid="remote-access-edge-fix">
          {t('settings.remoteAccess.edge.bypassFailedFix')}
        </p>
        <p>{t('settings.remoteAccess.edge.bypassFailedRetry')}</p>
      </>
    );
  }
  if (diagnosis === 'bypassed') {
    return (
      <p data-testid="remote-access-edge-bypassed">{t('settings.remoteAccess.edge.bypassed')}</p>
    );
  }
  if (connectorState(status) !== 'noConnections') return null;
  return <p data-testid="remote-access-degraded-hint">{t('settings.remoteAccess.degradedHint')}</p>;
}

/** 已绕开 fake-IP 劫持时在连接器旁多一行，交代当前用的是静态边缘地址而非系统解析结果。 */
function EdgeRow({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  if (edgeDiagnosis(status) !== 'bypassed') return null;
  return (
    <DetailRow label={t('settings.remoteAccess.edge.label')} testId="remote-access-edge">
      {t('settings.remoteAccess.edge.staticActive')}
    </DetailRow>
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
  return (
    <DangerConfirmDialog
      open={open}
      title={t('settings.remoteAccess.confirmRemove.title')}
      cancelLabel={t('settings.remoteAccess.confirmRemove.cancel')}
      confirmLabel={t('settings.remoteAccess.confirmRemove.confirm')}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="remote-access-confirm-remove"
      confirmTestId="remote-access-confirm-remove-confirm"
    >
      <span className="block">{t('settings.remoteAccess.confirmRemove.description')}</span>
      <span className="mt-2 block">{t('settings.remoteAccess.confirmRemove.irreversible')}</span>
    </DangerConfirmDialog>
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
