// 远程访问向导「启动临时隧道」步。

import type { TunnelStatusResponse } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Loader2, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SetupNotice } from '../nodes/setup/form-parts';
import {
  EXPOSURE_ACK,
  type ExposureState,
  ExposureWarning,
  exposureAck,
  exposureShown,
} from './exposure';
import { JobProgress } from './step-shell';
import type { TunnelActions } from './tunnel-actions';

export function QuickTunnelStep({
  status,
  actions,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const job = status.job;
  const starting = job?.kind === 'start' && job.state === 'running';
  const started = status.config.mode === 'quick' && status.process.publicUrl !== null;
  const ack = exposureAck(exposure, EXPOSURE_ACK.quick, exposureShown(exposure, 'compact'));

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
        <>
          <ExposureWarning
            exposure={exposure}
            ack={ack}
            testId="remote-access-quick-exposure"
            variant="compact"
          />
          <Button
            type="button"
            size="sm"
            disabled={actions.busy || !status.binary.installed}
            onClick={() => ack.submit(actions.run, { action: 'quick_start' })}
            data-testid="remote-access-quick-start"
          >
            {actions.pending === 'quick_start' ? <Loader2 className="animate-spin" /> : <Rocket />}
            {t('settings.remoteAccess.actions.quickStart')}
          </Button>
        </>
      )}
    </div>
  );
}
