// 「服务器或电脑」页：安装 → 选接入方式 → 两条分支各自的分步指引。
// 分支步骤接着前两步继续编号，读起来是一条连续的流程。

import { joinCommand } from '@/node/enrollment';
import { useSharedAuthMode } from '@/node/mesh-nodes';
import { TUNNEL_STATUS_QUERY_KEY, fetchSelfTunnelStatus } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import { INSTALL_COMMAND } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';
import { type EntryStatus, type HubStatus, entryStatus, hubStatus } from './host-status';
import { joinCommandPreview } from './join-command-preview';
import { JoinConfirmStatus, JoinTokenFields, useJoinEnrollment } from './join-token';

type Mode = 'join' | 'host';

const MODES: Mode[] = ['join', 'host'];
const PATH_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';
/** 安装、选择接入方式两步固定在前，分支步骤从 3 开始。 */
const BRANCH_STEP_OFFSET = 3;

export function JoinSteps() {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.join';
  const enrollment = useJoinEnrollment();
  const { create } = enrollment;
  // 加入码已生成就给真命令，否则给形状一致的预览（节点名随输入实时变化）。
  const ready = create.created !== null && create.hubUrl !== null;
  const command =
    create.created && create.hubUrl
      ? joinCommand(create.hubUrl, create.created.joinToken, create.created.pending.name)
      : joinCommandPreview({
          hubPublicUrl: create.hubUrl,
          name: create.name,
          tokenPlaceholder: t(`${prefix}.run.tokenPlaceholder`),
          namePlaceholder: t(`${prefix}.run.namePlaceholder`),
        });

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
        description={t(
          enrollment.meshEnabled ? `${prefix}.token.meshDescription` : `${prefix}.token.description`
        )}
      >
        <JoinTokenFields enrollment={enrollment} />
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 2}
        testId="connect-step-join-run"
        title={t(`${prefix}.run.title`)}
        description={t(ready ? `${prefix}.run.ready` : `${prefix}.run.description`)}
      >
        <CommandBlock value={command} testId="join" />
      </GuideStep>
      <GuideStep
        index={BRANCH_STEP_OFFSET + 3}
        testId="connect-step-join-confirm"
        title={t(`${prefix}.confirm.title`)}
        description={t(
          enrollment.meshEnabled
            ? `${prefix}.confirm.meshDescription`
            : `${prefix}.confirm.description`
        )}
      >
        <JoinConfirmStatus enrollment={enrollment} />
        {enrollment.meshEnabled && (
          <GuideLink to="/settings?tab=nodes" testId="connect-join-manage-link">
            {t(`${prefix}.token.link`)}
          </GuideLink>
        )}
      </GuideStep>
      {enrollment.dialog}
    </>
  );
}

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
  const running = t(`settings.remoteAccess.state.${entry.running ? 'running' : 'stopped'}`);
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
