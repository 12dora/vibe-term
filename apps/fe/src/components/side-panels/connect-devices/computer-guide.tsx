// 「服务器或电脑」页：安装 → 选接入方式 → 两条分支各自的分步指引。
// 分支步骤接着前两步继续编号，读起来是一条连续的流程。

import { INSTALL_COMMAND } from '@tmex/shared';
import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';

type Mode = 'join' | 'host';

const MODES: Mode[] = ['join', 'host'];
const PATH_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';
/** 安装、选择接入方式两步固定在前，分支步骤从 3 开始。 */
const BRANCH_STEP_OFFSET = 3;

export function JoinSteps() {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.join';
  return (
    <>
      <GuideStep
        index={BRANCH_STEP_OFFSET}
        testId="connect-step-join-hub"
        title={t(`${prefix}.hub.title`)}
        description={t(`${prefix}.hub.description`)}
      />
      <GuideStep
        index={BRANCH_STEP_OFFSET + 1}
        testId="connect-step-join-token"
        title={t(`${prefix}.token.title`)}
        description={t(`${prefix}.token.description`)}
      >
        <GuideLink to="/settings?tab=nodes" testId="connect-join-token-link">
          {t(`${prefix}.token.link`)}
        </GuideLink>
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 2}
        testId="connect-step-join-run"
        title={t(`${prefix}.run.title`)}
        description={t(`${prefix}.run.description`)}
      >
        <CommandBlock value={t(`${prefix}.run.example`)} testId="join" />
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 3}
        testId="connect-step-join-confirm"
        title={t(`${prefix}.confirm.title`)}
        description={t(`${prefix}.confirm.description`)}
      />
    </>
  );
}

export function HostSteps() {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.host';
  return (
    <>
      <GuideStep
        index={BRANCH_STEP_OFFSET}
        testId="connect-step-host-entry"
        title={t(`${prefix}.entry.title`)}
        description={t(`${prefix}.entry.description`)}
      >
        <GuideLink to="/settings?tab=remoteAccess" testId="connect-host-entry-link">
          {t(`${prefix}.entry.link`)}
        </GuideLink>
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 1}
        testId="connect-step-host-hub"
        title={t(`${prefix}.hub.title`)}
        description={t(`${prefix}.hub.description`)}
      >
        <p
          className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="connect-host-hub-warning"
        >
          {t(`${prefix}.hub.warning`)}
        </p>
        <GuideLink to="/settings?tab=nodes" testId="connect-host-hub-link">
          {t(`${prefix}.hub.link`)}
        </GuideLink>
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 2}
        testId="connect-step-host-invite"
        title={t(`${prefix}.invite.title`)}
        description={t(`${prefix}.invite.description`)}
      />
    </>
  );
}

export function ComputerGuide() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('join');

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('connectDevices.computer.intro')}</p>
      <div className="space-y-2">
        <GuideStep
          index={1}
          testId="connect-step-install"
          title={t('connectDevices.computer.install.title')}
          description={t('connectDevices.computer.install.description')}
        >
          <CommandBlock
            value={INSTALL_COMMAND}
            testId="install"
            label={t('connectDevices.computer.install.command')}
          />
          <p className="text-xs text-muted-foreground">
            {t('connectDevices.computer.install.pathHint')}
          </p>
          <CommandBlock value={PATH_COMMAND} testId="path" />
        </GuideStep>
        {/* Tabs 根同时罩住「选择接入方式」这一步与它下面的分支步骤：
            按钮在卡片里、面板在卡片外，靠同一个根拿到 tab / tabpanel 关联。 */}
        <Tabs className="gap-2" value={mode} onValueChange={(next) => setMode(next as Mode)}>
          <GuideStep
            index={2}
            testId="connect-step-mode"
            title={t('connectDevices.computer.mode.title')}
          >
            <GuideTabList
              options={MODES.map((value) => ({
                value,
                label: t(`connectDevices.computer.mode.${value}`),
                testId: `connect-mode-${value}`,
              }))}
            />
          </GuideStep>
          <TabsContent value="join" className="space-y-2">
            <JoinSteps />
          </TabsContent>
          <TabsContent value="host" className="space-y-2">
            <HostSteps />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
