// 远程访问向导「安装 cloudflared」步：已装展示版本 / 源 / 路径，未装才给出安装按钮。

import type { TunnelStatusResponse } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SetupNotice } from '../nodes/setup/form-parts';
import { DetailRow, JobProgress } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { describeTunnelError } from './tunnel-model';

export function InstallStep({
  status,
  actions,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
}) {
  const { t } = useTranslation();
  if (!status.supported && !status.config.externallyManaged) {
    return (
      <SetupNotice tone="warning" testId="remote-access-unsupported">
        {t('settings.remoteAccess.unsupported', { platform: status.platform })}
      </SetupNotice>
    );
  }
  if (status.binary.installed) return <InstalledBinaryDetails status={status} />;
  if (status.config.externallyManaged) {
    return (
      <SetupNotice tone="info" testId="remote-access-install-skipped">
        {t('settings.remoteAccess.steps.install.skipped')}
      </SetupNotice>
    );
  }
  return <InstallAction status={status} actions={actions} />;
}

function InstalledBinaryDetails({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
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

function InstallAction({
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
