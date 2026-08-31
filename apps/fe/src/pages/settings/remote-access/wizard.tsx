// 远程访问向导。步骤序列随方式变化：
//   命名隧道 安装 → 方式 → 登录 → 主机名 → 访问控制 → 创建并启动 → 反向代理信任
//   临时隧道 安装 → 方式 → 启动 → 反向代理信任
//   直接连接 方式 → 访问保护（不建隧道，也就不需要 cloudflared 与反向代理信任两步）

import type { LocalAuthStatus, TunnelStatusResponse } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Cloud, Download, Loader2, Rocket, RotateCcw, Server, Zap } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useRestartGateway } from '../nodes/restart/use-restart-now';
import { SetupNotice, SwitchRow } from '../nodes/setup/form-parts';
import { accessStepTag } from './access-model';
import { AccessStep } from './access-step';
import { DirectStep } from './direct-step';
import { type ExposureState, ExposureWarning } from './exposure';
import { ExternalTunnelCard } from './external-card';
import { CreateStep, HostnameStep, LoginStep, type NamedDraft } from './named-step';
import { DetailRow, JobProgress, WizardStepCard } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import {
  type WizardMode,
  type WizardStepId,
  describeTunnelError,
  effectiveMode,
  isAuthRequiredError,
  trustProxyRestartRequired,
  wizardStepState,
  wizardSteps,
} from './tunnel-model';

export interface TunnelWizardProps {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  chosenMode: WizardMode | null;
  onChooseMode: (mode: WizardMode) => void;
  draft: NamedDraft;
  isHub: boolean;
  exposure: ExposureState;
  onRestarted: () => void;
  /** 「直接连接」路径用的本机登录状态，来自 `/api/auth/mode`。 */
  localAuth: LocalAuthStatus | null;
  onLocalAuth: (next: LocalAuthStatus) => void;
}

export function TunnelWizard({
  status,
  actions,
  chosenMode,
  onChooseMode,
  draft,
  isHub,
  exposure,
  onRestarted,
  localAuth,
  onLocalAuth,
}: TunnelWizardProps) {
  const { t } = useTranslation();
  const [externalDismissed, setExternalDismissed] = useState(false);

  const ctx = { status, chosenMode, hostnameConfirmed: draft.confirmed, localAuth };
  const steps = wizardSteps(ctx);
  const authRequired = isAuthRequiredError(status, actions.error);
  const showExternal =
    status.external.detected && status.config.mode === 'off' && !externalDismissed;

  return (
    <Card data-testid="remote-access-wizard">
      <CardHeader>
        <CardTitle>{t('settings.remoteAccess.wizardTitle')}</CardTitle>
        <CardDescription>{t('settings.remoteAccess.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showExternal && (
          <ExternalTunnelCard
            status={status}
            actions={actions}
            onDismiss={() => setExternalDismissed(true)}
          />
        )}

        {steps.map((step, index) => (
          <StepSlot
            key={step}
            step={step}
            index={index + 1}
            state={wizardStepState(step, ctx)}
            status={status}
          >
            {step === 'mode' && authRequired && (
              <SetupNotice tone="warning" testId="remote-access-auth-required">
                <p>{t('settings.remoteAccess.authRequired.notice')}</p>
                <Link className="text-primary underline-offset-4 hover:underline" to="?tab=nodes">
                  {t('settings.remoteAccess.authRequired.link')}
                </Link>
              </SetupNotice>
            )}
            {step === 'mode' && (
              <ExposureWarning
                exposure={exposure}
                id="remote-access-mode-ack"
                testId="remote-access-exposure"
              />
            )}
            <StepContent
              step={step}
              status={status}
              actions={actions}
              draft={draft}
              isHub={isHub}
              exposure={exposure}
              chosenMode={chosenMode}
              onChooseMode={onChooseMode}
              onRestarted={onRestarted}
              localAuth={localAuth}
              onLocalAuth={onLocalAuth}
            />
          </StepSlot>
        ))}
      </CardContent>
    </Card>
  );
}

function StepSlot({
  step,
  index,
  state,
  status,
  children,
}: {
  step: WizardStepId;
  index: number;
  state: 'todo' | 'current' | 'done';
  status: TunnelStatusResponse;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <WizardStepCard
      index={index}
      testId={`remote-access-step-${step}`}
      state={state}
      title={t(`settings.remoteAccess.steps.${step}.title`)}
      description={t(`settings.remoteAccess.steps.${step}.description`)}
      tag={
        step === 'access'
          ? t(`settings.remoteAccess.access.tag.${accessStepTag(status)}`)
          : undefined
      }
    >
      {children}
    </WizardStepCard>
  );
}

function StepContent({
  step,
  status,
  actions,
  draft,
  isHub,
  exposure,
  chosenMode,
  onChooseMode,
  onRestarted,
  localAuth,
  onLocalAuth,
}: {
  step: WizardStepId;
  status: TunnelStatusResponse;
  actions: TunnelActions;
  draft: NamedDraft;
  isHub: boolean;
  exposure: ExposureState;
  chosenMode: WizardMode | null;
  onChooseMode: (mode: WizardMode) => void;
  onRestarted: () => void;
  localAuth: LocalAuthStatus | null;
  onLocalAuth: (next: LocalAuthStatus) => void;
}) {
  const { t } = useTranslation();
  switch (step) {
    case 'install':
      return <InstallStep status={status} actions={actions} />;
    case 'mode':
      // 选方式只是本地选择，装不装 cloudflared 由后面的安装步把关；
      // 「直接连接」压根不需要它，按二进制状态锁死整块会让这条路径不可达。
      return (
        <ModeChooser
          selected={effectiveMode(status, chosenMode)}
          locked={status.config.mode !== 'off'}
          disabled={actions.busy}
          onSelect={onChooseMode}
        />
      );
    case 'direct':
      return <DirectStep status={status} localAuth={localAuth} onLocalAuth={onLocalAuth} />;
    case 'tunnel':
      return (
        <p className="text-xs text-muted-foreground" data-testid="remote-access-step-tunnel-idle">
          {t('settings.remoteAccess.steps.mode.pending')}
        </p>
      );
    case 'quick':
      return <QuickTunnelStep status={status} actions={actions} exposure={exposure} />;
    case 'login':
      return <LoginStep status={status} actions={actions} />;
    case 'hostname':
      return <HostnameStep status={status} actions={actions} draft={draft} isHub={isHub} />;
    case 'access':
      return (
        <AccessStep
          status={status}
          actions={actions}
          draftHostname={draft.hostname}
          exposure={exposure}
        />
      );
    case 'create':
      return (
        <CreateStep
          status={status}
          actions={actions}
          draft={draft}
          isHub={isHub}
          exposure={exposure}
        />
      );
    case 'proxy':
      return (
        <ProxyStep
          status={status}
          actions={actions}
          exposure={exposure}
          onRestarted={onRestarted}
        />
      );
  }
}

function InstallStep({
  status,
  actions,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
}) {
  const { t } = useTranslation();
  const job = status.job;
  const installing = job?.kind === 'install' && job.state === 'running';
  const installFailed = job?.kind === 'install' && job.state === 'error' && job.error !== null;

  if (!status.supported && !status.config.externallyManaged) {
    return (
      <SetupNotice tone="warning" testId="remote-access-unsupported">
        {t('settings.remoteAccess.unsupported', { platform: status.platform })}
      </SetupNotice>
    );
  }

  if (status.binary.installed) {
    return (
      <div className="space-y-0.5" data-testid="remote-access-binary">
        <DetailRow label={t('settings.remoteAccess.steps.install.version')}>
          <span className="font-mono">{status.binary.version ?? '—'}</span>
        </DetailRow>
        {status.binary.source && (
          <DetailRow label={t('settings.remoteAccess.steps.install.source')}>
            {t(`settings.remoteAccess.steps.install.sourceValue.${status.binary.source}`)}
          </DetailRow>
        )}
        {status.binary.path && (
          <DetailRow label={t('settings.remoteAccess.steps.install.path')}>
            <span className="font-mono">{status.binary.path}</span>
          </DetailRow>
        )}
      </div>
    );
  }

  if (status.config.externallyManaged) {
    return (
      <SetupNotice tone="info" testId="remote-access-install-skipped">
        {t('settings.remoteAccess.steps.install.skipped')}
      </SetupNotice>
    );
  }

  return (
    <div className="space-y-2">
      {installFailed && job.error && (
        <SetupNotice tone="error" testId="remote-access-install-error">
          {describeTunnelError(t, job.error)}
        </SetupNotice>
      )}
      {installing ? (
        <JobProgress step={job.step} testId="remote-access-install-progress" />
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={actions.busy}
          onClick={() => actions.run({ action: 'install' })}
          data-testid="remote-access-install"
        >
          {actions.pending === 'install' ? <Loader2 className="animate-spin" /> : <Download />}
          {t('settings.remoteAccess.actions.install')}
        </Button>
      )}
    </div>
  );
}

function ModeChooser({
  selected,
  locked,
  disabled,
  onSelect,
}: {
  selected: WizardMode;
  /** 已经建过隧道：换方式必须先「移除」，这里只展示当前方式。 */
  locked: boolean;
  disabled: boolean;
  onSelect: (mode: WizardMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-3"
      role="radiogroup"
      aria-label={t('settings.remoteAccess.steps.mode.title')}
      data-testid="remote-access-mode-chooser"
    >
      <ModeCard
        mode="quick"
        icon={<Zap className="size-4" />}
        selected={selected === 'quick'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
      <ModeCard
        mode="named"
        icon={<Cloud className="size-4" />}
        selected={selected === 'named'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
      <ModeCard
        mode="direct"
        icon={<Server className="size-4" />}
        selected={selected === 'direct'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
    </div>
  );
}

function ModeCard({
  mode,
  icon,
  selected,
  disabled,
  onSelect,
}: {
  mode: Exclude<WizardMode, 'off'>;
  icon: ReactNode;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: WizardMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      data-testid={`remote-access-mode-${mode}`}
      data-selected={selected ? 'true' : 'false'}
      className={`flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
        selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input
        type="radio"
        name="remote-access-mode"
        data-testid={`remote-access-mode-${mode}-input`}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(mode)}
      />
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {t(`settings.remoteAccess.mode.${mode}.title`)}
      </span>
      <span className="text-xs text-muted-foreground">
        {t(`settings.remoteAccess.mode.${mode}.description`)}
      </span>
    </label>
  );
}

function QuickTunnelStep({
  status,
  actions,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const job = status.job;
  const starting = job?.kind === 'start' && job.state === 'running';
  const started = status.config.mode === 'quick' && status.process.publicUrl !== null;

  return (
    <div className="space-y-2" data-testid="remote-access-quick">
      {started ? (
        <SetupNotice tone="success" testId="remote-access-quick-started">
          <p>{t('settings.remoteAccess.steps.quick.started')}</p>
          <p className="font-mono break-all" data-testid="remote-access-quick-url">
            {status.process.publicUrl}
          </p>
        </SetupNotice>
      ) : starting ? (
        <JobProgress step={job.step} testId="remote-access-quick-progress" />
      ) : (
        <>
          <ExposureWarning
            exposure={exposure}
            id="remote-access-quick-ack"
            testId="remote-access-quick-exposure"
            variant="compact"
          />
          <Button
            type="button"
            size="sm"
            disabled={actions.busy || !status.binary.installed}
            onClick={() => actions.run({ action: 'quick_start' })}
            data-testid="remote-access-quick-start"
          >
            {actions.pending === 'quick_start' ? <Loader2 className="animate-spin" /> : <Rocket />}
            {t('settings.remoteAccess.actions.quickStart')}
          </Button>
        </>
      )}
    </div>
  );
}

function ProxyStep({
  status,
  actions,
  exposure,
  onRestarted,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
  onRestarted: () => void;
}) {
  const { t } = useTranslation();
  const restart = useRestartGateway(undefined, onRestarted);
  const restartRequired = trustProxyRestartRequired(status);

  return (
    <div className="space-y-3">
      {/* 开关绑已保存值：生效值要等重启，直接绑它会让开关在保存后弹回去。 */}
      <SwitchRow
        id="remote-access-trust-proxy"
        label={t('settings.remoteAccess.steps.proxy.trustProxy')}
        hint={t('settings.remoteAccess.steps.proxy.trustProxyHint')}
        checked={status.configuredTrustProxy}
        disabled={actions.busy}
        onCheckedChange={(checked) =>
          actions.run({ action: 'set_trust_proxy', trustProxy: checked })
        }
      />
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.steps.proxy.trustProxyDetail')}
      </p>
      <DetailRow
        label={t('settings.remoteAccess.steps.proxy.trustProxyEffective')}
        testId="remote-access-trust-proxy-effective"
      >
        {t(`settings.remoteAccess.steps.proxy.trustProxyState.${status.trustProxy ? 'on' : 'off'}`)}
      </DetailRow>

      {!status.config.externallyManaged && (
        <>
          <SwitchRow
            id="remote-access-auto-start"
            label={t('settings.remoteAccess.steps.proxy.autoStart')}
            hint={t('settings.remoteAccess.steps.proxy.autoStartHint')}
            checked={status.config.autoStart}
            disabled={actions.busy}
            onCheckedChange={(checked) =>
              actions.run({ action: 'set_auto_start', autoStart: checked })
            }
          />
          {!status.config.autoStart && (
            <ExposureWarning
              exposure={exposure}
              id="remote-access-auto-start-ack"
              testId="remote-access-auto-start-exposure"
              variant="compact"
            />
          )}
        </>
      )}

      {restartRequired && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="remote-access-restart-required"
        >
          <span>
            {restart.state === 'waiting'
              ? t('settings.remoteAccess.steps.proxy.restarting')
              : restart.state === 'timeout'
                ? t('settings.remoteAccess.steps.proxy.restartTimeout')
                : t('settings.remoteAccess.steps.proxy.restartRequired')}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={restart.waiting}
            onClick={() => void restart.run()}
            data-testid="remote-access-restart-now"
          >
            {restart.waiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {t('settings.remoteAccess.steps.proxy.restartNow')}
          </Button>
        </div>
      )}
    </div>
  );
}
