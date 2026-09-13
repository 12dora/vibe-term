// 远程访问向导。第 1 步先选连接方式（Cloudflare Tunnel / 直接连接），之后按分支展开：
//   命名隧道 连接方式 → 安装 → 隧道类型 → 登录 → 主机名 → 访问控制 → 创建并启动 → 反向代理信任
//   临时隧道 连接方式 → 安装 → 隧道类型 → 启动 → 反向代理信任
//   直接连接 连接方式 → 访问保护（不建隧道，也就不需要 cloudflared 与反向代理信任两步）

import type { LocalAuthStatus, TunnelStatusResponse } from '@vibeterm/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SetupNotice } from '../nodes/setup/form-parts';
import { accessStepTag } from './access-model';
import { AccessStep } from './access-step';
import { DirectStep } from './direct-step';
import { type ExposureState, ExposureWarning } from './exposure';
import { ExternalTunnelCard } from './external-card';
import { InstallStep } from './install-step';
import { CreateStep, HostnameStep, LoginStep, type NamedDraft } from './named-step';
import { ProxyStep } from './proxy-step';
import { QuickTunnelStep } from './quick-step';
import { WizardStepCard } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import {
  type ConnectionPath,
  type WizardMode,
  type WizardStepId,
  effectiveMode,
  effectivePath,
  isAuthRequiredError,
  wizardStepState,
  wizardSteps,
} from './tunnel-model';
import { ModeChooser, PathChooser } from './wizard-choosers';

export interface TunnelWizardProps {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  chosenPath: ConnectionPath | null;
  onChoosePath: (path: ConnectionPath) => void;
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
  chosenPath,
  onChoosePath,
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

  const ctx = { status, chosenPath, chosenMode, hostnameConfirmed: draft.confirmed, localAuth };
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
            {/* 这一步没有会开放公网的动作：只提醒，确认勾选留给真正发起动作的那一步。 */}
            {step === 'mode' && (
              <ExposureWarning exposure={exposure} testId="remote-access-exposure" />
            )}
            <StepContent
              step={step}
              status={status}
              actions={actions}
              draft={draft}
              isHub={isHub}
              exposure={exposure}
              chosenPath={chosenPath}
              onChoosePath={onChoosePath}
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

interface StepContentProps {
  step: WizardStepId;
  status: TunnelStatusResponse;
  actions: TunnelActions;
  draft: NamedDraft;
  isHub: boolean;
  exposure: ExposureState;
  chosenPath: ConnectionPath | null;
  onChoosePath: (path: ConnectionPath) => void;
  chosenMode: WizardMode | null;
  onChooseMode: (mode: WizardMode) => void;
  onRestarted: () => void;
  localAuth: LocalAuthStatus | null;
  onLocalAuth: (next: LocalAuthStatus) => void;
}

function StepContent(props: StepContentProps) {
  return STEP_CONTENT[props.step](props);
}

const STEP_CONTENT: { [K in WizardStepId]: (p: StepContentProps) => ReactNode } = {
  path: (p) => (
    <PathChooser
      selected={effectivePath(p.status, p.chosenPath)}
      locked={p.status.config.mode !== 'off'}
      disabled={p.actions.busy}
      onSelect={p.onChoosePath}
    />
  ),
  install: (p) => <InstallStep status={p.status} actions={p.actions} />,
  // 选隧道类型只是本地选择，装不装 cloudflared 由安装步把关，这里不按二进制状态锁死。
  mode: (p) => (
    <ModeChooser
      selected={effectiveMode(p.status, p.chosenMode)}
      locked={p.status.config.mode !== 'off'}
      disabled={p.actions.busy}
      onSelect={p.onChooseMode}
    />
  ),
  direct: (p) => (
    <DirectStep status={p.status} localAuth={p.localAuth} onLocalAuth={p.onLocalAuth} />
  ),
  tunnel: () => <TunnelIdleHint />,
  quick: (p) => <QuickTunnelStep status={p.status} actions={p.actions} exposure={p.exposure} />,
  login: (p) => <LoginStep status={p.status} actions={p.actions} />,
  hostname: (p) => (
    <HostnameStep status={p.status} actions={p.actions} draft={p.draft} isHub={p.isHub} />
  ),
  access: (p) => (
    <AccessStep
      status={p.status}
      actions={p.actions}
      draftHostname={p.draft.hostname}
      exposure={p.exposure}
      localAuth={p.localAuth}
      onLocalAuth={p.onLocalAuth}
    />
  ),
  create: (p) => (
    <CreateStep
      status={p.status}
      actions={p.actions}
      draft={p.draft}
      isHub={p.isHub}
      exposure={p.exposure}
    />
  ),
  proxy: (p) => (
    <ProxyStep
      status={p.status}
      actions={p.actions}
      exposure={p.exposure}
      onRestarted={p.onRestarted}
    />
  ),
};

function TunnelIdleHint() {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground" data-testid="remote-access-step-tunnel-idle">
      {t('settings.remoteAccess.steps.mode.pending')}
    </p>
  );
}
