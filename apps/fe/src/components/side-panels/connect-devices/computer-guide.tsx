// 「服务器或电脑」页：安装 → 选接入方式 → 两条分支各自的分步指引。
// 分支步骤接着前两步继续编号，读起来是一条连续的流程。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { TUNNEL_STATUS_QUERY_KEY, fetchSelfTunnelStatus } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import { INSTALL_COMMAND } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { BRANCH_STEP_OFFSET, JoinSteps } from './computer-join-guide';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';
import { type EntryStatus, type HubStatus, entryStatus, hubStatus } from './host-status';

type Mode = 'join' | 'host';

const MODES: Mode[] = ['join', 'host'];
const PATH_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';

/** 三步各自的现状：隧道状态给公网入口，`/api/auth/mode` 给中继角色。两路都没到就按「什么都没配」渲染静态文案。 */
function useHostStatus(): { entry: EntryStatus; hub: HubStatus } {
  const { mode } = useSharedAuthMode();
  const tunnel = useQuery({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: fetchSelfTunnelStatus,
    staleTime: 10_000,
    retry: false,
  });
  const entry = entryStatus(tunnel.data, mode?.mode === 'mesh' ? mode.hubPublicUrl : null);
  return { entry, hub: hubStatus(mode, entry) };
}

function HostEntryStep({ entry }: { entry: EntryStatus }) {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.host.entry';
  const link = (
    <GuideLink to="/settings?tab=remoteAccess" testId="connect-host-entry-link">
      {t(`${prefix}.link`)}
    </GuideLink>
  );
  if (entry.kind === 'none') {
    return (
      <GuideStep
        index={BRANCH_STEP_OFFSET}
        testId="connect-step-host-entry"
        title={t(`${prefix}.title`)}
        description={t(`${prefix}.description`)}
      >
        {link}
      </GuideStep>
    );
  }
  const state = entry.degraded ? 'degraded' : entry.running ? 'running' : 'stopped';
  const running = t(`settings.remoteAccess.state.${state}`);
  return (
    <GuideStep
      index={BRANCH_STEP_OFFSET}
      state="done"
      testId="connect-step-host-entry"
      title={t(`${prefix}.title`)}
    >
      <GuideNote testId="connect-host-entry-status">
        {entry.kind === 'hubUrl'
          ? t(`${prefix}.status.hubUrl`, { url: entry.url })
          : t(`${prefix}.status.named`, { url: entry.url, state: running })}
      </GuideNote>
      {entry.kind === 'quick' && (
        <GuideNote tone="warning" testId="connect-host-entry-quick">
          {t(`${prefix}.status.quick`, { url: entry.url })}
        </GuideNote>
      )}
      {link}
    </GuideStep>
  );
}

function HostHubStep({ entry, hub }: { entry: EntryStatus; hub: HubStatus }) {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.host.hub';
  const link = (
    <GuideLink to="/settings?tab=nodes" testId="connect-host-hub-link">
      {t(`${prefix}.link`)}
    </GuideLink>
  );
  const url = hub.url ?? t('common.unknown');
  if (hub.role !== 'standalone') {
    return (
      <GuideStep
        index={BRANCH_STEP_OFFSET + 1}
        state={hub.role === 'self' ? 'done' : 'todo'}
        testId="connect-step-host-hub"
        title={t(`${prefix}.title`)}
      >
        <GuideNote testId="connect-host-hub-status">
          {t(`${prefix}.status.${hub.role}`, { url })}
        </GuideNote>
        {hub.mismatch && (
          <GuideNote tone="warning" testId="connect-host-hub-mismatch">
            {t(`${prefix}.status.mismatch`)}
          </GuideNote>
        )}
        {hub.role === 'self' && link}
      </GuideStep>
    );
  }
  return (
    <GuideStep
      index={BRANCH_STEP_OFFSET + 1}
      testId="connect-step-host-hub"
      title={t(`${prefix}.title`)}
      description={t(`${prefix}.description`)}
    >
      {entry.hostname && (
        <GuideNote testId="connect-host-hub-hint">
          {t(`${prefix}.hintUseEntry`, { url: entry.url })}
        </GuideNote>
      )}
      <GuideNote tone="warning" testId="connect-host-hub-warning">
        {t(`${prefix}.warning`)}
      </GuideNote>
      {link}
    </GuideStep>
  );
}

function HostInviteStep({ isHub, onSwitchToJoin }: { isHub: boolean; onSwitchToJoin: () => void }) {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.host.invite';
  return (
    <GuideStep
      index={BRANCH_STEP_OFFSET + 2}
      testId="connect-step-host-invite"
      title={t(`${prefix}.title`)}
      description={t(isHub ? `${prefix}.ready` : `${prefix}.description`)}
    >
      {isHub && (
        <Button
          size="xs"
          variant="outline"
          data-testid="connect-host-goto-join"
          onClick={onSwitchToJoin}
        >
          {t(`${prefix}.gotoJoin`)}
        </Button>
      )}
    </GuideStep>
  );
}

export function HostSteps({ onSwitchToJoin }: { onSwitchToJoin: () => void }) {
  const { entry, hub } = useHostStatus();
  return (
    <>
      <HostEntryStep entry={entry} />
      <HostHubStep entry={entry} hub={hub} />
      <HostInviteStep isHub={hub.role === 'self'} onSwitchToJoin={onSwitchToJoin} />
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
            <HostSteps onSwitchToJoin={() => setMode('join')} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
