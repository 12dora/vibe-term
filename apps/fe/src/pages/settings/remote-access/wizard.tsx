// 远程访问向导：安装 cloudflared → 选择方式 → 建立隧道 → 反向代理信任。

import type { TunnelMode, TunnelStatusResponse } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Cloud, Download, Loader2, Rocket, RotateCcw, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRestartGateway } from '../nodes/restart/use-restart-now';
import { SetupNotice, SwitchRow } from '../nodes/setup/form-parts';
import { NamedTunnelStep } from './named-step';
import { DetailRow, JobProgress, WizardStepCard } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { currentWizardStep, describeTunnelError, effectiveMode, stepState } from './tunnel-model';

export interface TunnelWizardProps {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  chosenMode: TunnelMode | null;
  onChooseMode: (mode: TunnelMode) => void;
  isHub: boolean;
  onRestarted: () => void;
}

export function TunnelWizard({
  status,
  actions,
  chosenMode,
  onChooseMode,
  isHub,
  onRestarted,
}: TunnelWizardProps) {
  const { t } = useTranslation();
  const current = currentWizardStep(status, chosenMode);
  const mode = effectiveMode(status, chosenMode);

  return (
    <Card data-testid="remote-access-wizard">
      <CardHeader>
        <CardTitle>{t('settings.remoteAccess.wizardTitle')}</CardTitle>
        <CardDescription>{t('settings.remoteAccess.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <WizardStepCard
          index={1}
          testId="remote-access-step-install"
          state={stepState(1, current)}
          title={t('settings.remoteAccess.steps.install.title')}
          description={t('settings.remoteAccess.steps.install.description')}
        >
          <InstallStep status={status} actions={actions} />
        </WizardStepCard>

        <WizardStepCard
          index={2}
          testId="remote-access-step-mode"
          state={stepState(2, current)}
          title={t('settings.remoteAccess.steps.mode.title')}
          description={t('settings.remoteAccess.steps.mode.description')}
        >
          <ModeChooser
            selected={mode}
            locked={status.config.mode !== 'off'}
            disabled={actions.busy || !status.binary.installed}
            onSelect={onChooseMode}
          />
        </WizardStepCard>

        <WizardStepCard
          index={3}
          testId="remote-access-step-tunnel"
          state={stepState(3, current)}
          title={t(`settings.remoteAccess.steps.${mode === 'off' ? 'tunnel' : mode}.title`)}
          description={t(
            `settings.remoteAccess.steps.${mode === 'off' ? 'tunnel' : mode}.description`
          )}
        >
          {mode === 'off' ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="remote-access-step-tunnel-idle"
            >
              {t('settings.remoteAccess.steps.mode.pending')}
            </p>
          ) : mode === 'named' ? (
            <NamedTunnelStep status={status} actions={actions} isHub={isHub} />
          ) : (
            <QuickTunnelStep status={status} actions={actions} />
          )}
        </WizardStepCard>

        <WizardStepCard
          index={4}
          testId="remote-access-step-proxy"
          state={stepState(4, current)}
          title={t('settings.remoteAccess.steps.proxy.title')}
          description={t('settings.remoteAccess.steps.proxy.description')}
        >
          <ProxyStep status={status} actions={actions} onRestarted={onRestarted} />
        </WizardStepCard>
      </CardContent>
    </Card>
  );
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

  if (!status.supported) {
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
  selected: TunnelMode;
  /** 已经建过隧道：换方式必须先「移除」，这里只展示当前方式。 */
  locked: boolean;
  disabled: boolean;
  onSelect: (mode: TunnelMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
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
  mode: Exclude<TunnelMode, 'off'>;
  icon: ReactNode;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: TunnelMode) => void;
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
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
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
      )}
    </div>
  );
}

function ProxyStep({
  status,
  actions,
  onRestarted,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  onRestarted: () => void;
}) {
  const { t } = useTranslation();
  const restart = useRestartGateway(undefined, onRestarted);

  return (
    <div className="space-y-3">
      <SwitchRow
        id="remote-access-trust-proxy"
        label={t('settings.remoteAccess.steps.proxy.trustProxy')}
        hint={t('settings.remoteAccess.steps.proxy.trustProxyHint')}
        checked={status.trustProxy}
        disabled={actions.busy}
        onCheckedChange={(checked) =>
          actions.run({ action: 'set_trust_proxy', trustProxy: checked })
        }
      />
      <SwitchRow
        id="remote-access-auto-start"
        label={t('settings.remoteAccess.steps.proxy.autoStart')}
        hint={t('settings.remoteAccess.steps.proxy.autoStartHint')}
        checked={status.config.autoStart}
        disabled={actions.busy}
        onCheckedChange={(checked) => actions.run({ action: 'set_auto_start', autoStart: checked })}
      />

      {status.restartRequired && (
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
