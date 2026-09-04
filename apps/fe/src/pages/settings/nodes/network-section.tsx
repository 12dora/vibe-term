// 「网络」段：直连插件与允许域名访问。两者都是本机的安装态 / 监听态，与角色无关，
// 因此不再挂在原来那个只有一行内容的「通用设置」标题下面。

import type { DomainAccessPolicy } from '@tmex/api-client';
import type { LocalDirectAction, LocalDirectStatus } from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DirectSection } from './direct-section';
import { type DomainAccessApi, DomainAccessRow } from './domain-access-row';
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
}: NetworkSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <DirectSection
        direct={direct}
        busy={busy}
        pending={pending}
        error={directError}
        onAction={onDirectAction}
      />
      {restartRequired && <RestartBanner restart={restart} busy={busy} />}
      {domainAccess && (
        <DomainAccessRow policy={domainAccess} api={domainApi} onRefresh={onRefresh} />
      )}
    </div>
  );
}

function RestartBanner({ restart, busy }: { restart: RestartGateway; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2 text-xs"
      data-testid="local-machine-restart-required"
    >
      <span className="text-muted-foreground">
        {t(RESTART_TEXT_KEY[restart.state] ?? 'nodes.machine.directRestartRequired')}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => void restart.run()}
        data-testid="local-machine-restart-now"
      >
        {restart.waiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        {t('nodes.machine.restartNow')}
      </Button>
    </div>
  );
}
