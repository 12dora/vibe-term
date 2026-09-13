// 「网络」段：端口、直连插件、允许域名访问。三行都是本机的监听态 / 安装态，与角色无关，
// 共用同一套 `Row` 版式；重启提示是唯一的例外——它是要人动手的问题，走 `Notice`。

import type { DomainAccessPolicy } from '@vibeterm/api-client';
import type { LocalDirectAction, LocalDirectStatus } from '@vibeterm/api-client/local/types';
import type { PortSpec } from '@vibeterm/shared/net';
import { useTranslation } from 'react-i18next';
import { Notice, NoticeAction } from './card-parts';
import { DirectSection } from './direct-section';
import { type DomainAccessApi, DomainAccessRow } from './domain-access-row';
import type { MeshPortReach } from './port-reach';
import { PortsSection, type ProbeNodePorts } from './ports-section';
import type { RestartGateway, RestartState } from './restart/use-restart-now';

const RESTART_TEXT_KEY: Partial<Record<RestartState, string>> = {
  waiting: 'nodes.machine.restarting',
  timeout: 'nodes.machine.restartTimeout',
};

export interface NetworkSectionProps {
  direct: LocalDirectStatus;
  busy: boolean;
  pending: LocalDirectAction | null;
  directError: string | null;
  onDirectAction: (action: LocalDirectAction) => void;
  restartRequired: boolean;
  restart: RestartGateway;
  domainAccess: DomainAccessPolicy | null;
  domainApi: DomainAccessApi;
  onRefresh: () => void;
  portPlan?: PortSpec[];
  portReach?: MeshPortReach[] | null;
  selfNodeId?: string | null;
  probe?: ProbeNodePorts;
}

export function NetworkSection({
  direct,
  busy,
  pending,
  directError,
  onDirectAction,
  restartRequired,
  restart,
  domainAccess,
  domainApi,
  onRefresh,
  portPlan,
  portReach,
  selfNodeId,
  probe,
}: NetworkSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      {portPlan && (
        <PortsSection plan={portPlan} reach={portReach} selfNodeId={selfNodeId} probe={probe} />
      )}
      <DirectSection
        direct={direct}
        busy={busy}
        pending={pending}
        error={directError}
        onAction={onDirectAction}
      />
      {restartRequired && <RestartNotice restart={restart} busy={busy} />}
      {domainAccess && (
        <DomainAccessRow policy={domainAccess} api={domainApi} onRefresh={onRefresh} />
      )}
    </div>
  );
}

function RestartNotice({ restart, busy }: { restart: RestartGateway; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <Notice
      tone="muted"
      testId="local-machine-restart-required"
      spinner={restart.waiting}
      action={
        <NoticeAction
          label={t('nodes.machine.restartNow')}
          testId="local-machine-restart-now"
          disabled={busy || restart.waiting}
          onClick={() => void restart.run()}
        />
      }
    >
      {t(RESTART_TEXT_KEY[restart.state] ?? 'nodes.machine.directRestartRequired')}
    </Notice>
  );
}
