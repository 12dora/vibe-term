// 系统里已有的 cloudflared：探测到就先问用户是接管它，还是让 tmex 另建一条。
//
// 接管（`adopt_external`）只把 mode / hostname 记进 tmex，不去碰那个由 launchd/systemd
// 管着的进程——两边同时拉起同一条隧道只会互相顶掉。

import type { TunnelStatusResponse } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Loader2, PlugZap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SetupNotice } from '../nodes/setup/form-parts';
import { DetailRow } from './step-shell';
import type { TunnelActions } from './tunnel-actions';

const KNOWN_SOURCES = new Set(['launchd', 'systemd', 'process', 'config']);

export function ExternalTunnelCard({
  status,
  actions,
  onDismiss,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const external = status.external;
  const [hostname, setHostname] = useState(external.hostnames[0] ?? '');
  const target = external.hostnames.includes(hostname) ? hostname : (external.hostnames[0] ?? '');
  const source = external.source;

  return (
    <section
      className="space-y-3 rounded-xl bg-primary/5 p-3 ring-1 ring-primary"
      data-testid="remote-access-external"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{t('settings.remoteAccess.external.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.remoteAccess.external.description')}
        </p>
      </div>

      <div className="space-y-0.5">
        {source && (
          <DetailRow
            label={t('settings.remoteAccess.external.source')}
            testId="remote-access-external-source"
          >
            {KNOWN_SOURCES.has(source)
              ? t(`settings.remoteAccess.external.sourceValue.${source}`)
              : source}
          </DetailRow>
        )}
        {external.tunnelName && (
          <DetailRow label={t('settings.remoteAccess.steps.named.tunnelName')}>
            <span className="font-mono">{external.tunnelName}</span>
          </DetailRow>
        )}
        {external.tunnelId && (
          <DetailRow label={t('settings.remoteAccess.steps.named.tunnelId')}>
            <span className="font-mono">{external.tunnelId}</span>
          </DetailRow>
        )}
        {external.configPath && (
          <DetailRow label={t('settings.remoteAccess.external.configPath')}>
            <span className="font-mono">{external.configPath}</span>
          </DetailRow>
        )}
        <DetailRow
          label={t('settings.remoteAccess.external.running')}
          testId="remote-access-external-running"
        >
          {t(`settings.remoteAccess.external.runningValue.${external.running ? 'on' : 'off'}`)}
        </DetailRow>
      </div>

      {external.hostnames.length === 0 ? (
        <SetupNotice tone="warning" testId="remote-access-external-no-hostname">
          {t('settings.remoteAccess.external.noHostname')}
        </SetupNotice>
      ) : external.hostnames.length === 1 ? (
        <DetailRow
          label={t('settings.remoteAccess.steps.named.hostname')}
          testId="remote-access-external-hostname"
        >
          <span className="font-mono">{target}</span>
        </DetailRow>
      ) : (
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="remote-access-external-hostname">
            {t('settings.remoteAccess.external.chooseHostname')}
          </label>
          <Select value={target} onValueChange={(next) => next && setHostname(next)}>
            <SelectTrigger
              id="remote-access-external-hostname"
              data-testid="remote-access-external-hostname"
              className="w-full"
            >
              <SelectValue>{target}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {external.hostnames.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy || target.length === 0}
          onClick={() => actions.run({ action: 'adopt_external', hostname: target })}
          data-testid="remote-access-external-adopt"
        >
          {actions.pending === 'adopt_external' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <PlugZap />
          )}
          {t('settings.remoteAccess.external.adopt')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onDismiss}
          data-testid="remote-access-external-dismiss"
        >
          {t('settings.remoteAccess.external.dismiss')}
        </Button>
      </div>
    </section>
  );
}
