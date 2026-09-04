// 「本机设为 Hub」子路径：公网入口 → 设为 Hub → 接入其他机器。
// 三步的现状由隧道状态与 `/api/auth/mode` 推导（见 host-status.ts）。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { TUNNEL_STATUS_QUERY_KEY, fetchSelfTunnelStatus } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@tmex/ui/button';
import { useTranslation } from 'react-i18next';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { type EntryStatus, type HubStatus, entryStatus, hubStatus } from './host-status';

/** 一级选择占第 1 步，本机自建的步骤从 2 开始。 */
export const HOST_STEP_OFFSET = 2;

function useHostStatus(): { entry: EntryStatus; hub: HubStatus } {
  const { mode } = useSharedAuthMode();
  const tunnel = useQuery({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: fetchSelfTunnelStatus,
    staleTime: 10_000,
    retry: false,
  });
  // `hubPublicUrl` 只有在本机就是 Hub 时才是本机的公网入口；普通节点那是上级的地址。
  const selfHubUrl =
    mode?.mode === 'mesh' && mode.hubNodeId && mode.hubNodeId === mode.nodeId
      ? mode.hubPublicUrl
      : null;
  const entry = entryStatus(tunnel.data, selfHubUrl);
  return { entry, hub: hubStatus(mode, entry) };
}

function HostEntryStep({ entry, index }: { entry: EntryStatus; index: number }) {
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
        index={index}
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
      index={index}
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

function HostHubStep({
  entry,
  hub,
  index,
}: {
  entry: EntryStatus;
  hub: HubStatus;
  index: number;
}) {
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
        index={index}
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
      index={index}
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

function HostInviteStep({
  isHub,
  index,
  onSwitchToJoin,
}: {
  isHub: boolean;
  index: number;
  onSwitchToJoin: () => void;
}) {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.host.invite';
  return (
    <GuideStep
      index={index}
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

export function HostSteps({
  onSwitchToJoin,
  startIndex = HOST_STEP_OFFSET,
}: {
  onSwitchToJoin: () => void;
  startIndex?: number;
}) {
  const { entry, hub } = useHostStatus();
  return (
    <>
      <HostEntryStep entry={entry} index={startIndex} />
      <HostHubStep entry={entry} hub={hub} index={startIndex + 1} />
      <HostInviteStep
        isHub={hub.role === 'self'}
        index={startIndex + 2}
        onSwitchToJoin={onSwitchToJoin}
      />
    </>
  );
}
