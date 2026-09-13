// 远程访问向导「反向代理信任」步：trust-proxy / 开机自启，以及保存后待重启的提示。

import type { TunnelStatusResponse } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRestartGateway } from '../nodes/restart/use-restart-now';
import { SwitchRow } from '../nodes/setup/form-parts';
import {
  EXPOSURE_ACK,
  type ExposureState,
  ExposureWarning,
  exposureAck,
  exposureShown,
} from './exposure';
import { DetailRow } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { trustProxyRestartRequired } from './tunnel-model';

export function ProxyStep({
  status,
  actions,
  exposure,
  onRestarted,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
  onRestarted: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {/* 开关绑已保存值：生效值要等重启，直接绑它会让开关在保存后弹回去。 */}
      <SwitchRow
        id="remote-access-trust-proxy"
        label={t('settings.remoteAccess.steps.proxy.trustProxy')}
        hint={t('settings.remoteAccess.steps.proxy.trustProxyHint')}
        checked={status.configuredTrustProxy}
        disabled={actions.busy}
        onCheckedChange={(checked) =>
          actions.run({ action: 'set_trust_proxy', trustProxy: checked })
        }
      />
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.steps.proxy.trustProxyDetail')}
      </p>
      <DetailRow
        label={t('settings.remoteAccess.steps.proxy.trustProxyEffective')}
        testId="remote-access-trust-proxy-effective"
      >
        {t(`settings.remoteAccess.steps.proxy.trustProxyState.${status.trustProxy ? 'on' : 'off'}`)}
      </DetailRow>

      {!status.config.externallyManaged && (
        <AutoStartControls status={status} actions={actions} exposure={exposure} />
      )}

      <RestartRequiredBanner status={status} onRestarted={onRestarted} />
    </div>
  );
}

function AutoStartControls({
  status,
  actions,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const autoStartAck = exposureAck(
    exposure,
    EXPOSURE_ACK.autoStart,
    !status.config.autoStart && exposureShown(exposure, 'compact')
  );
  return (
    <>
      <SwitchRow
        id="remote-access-auto-start"
        label={t('settings.remoteAccess.steps.proxy.autoStart')}
        hint={t('settings.remoteAccess.steps.proxy.autoStartHint')}
        checked={status.config.autoStart}
        disabled={actions.busy}
        onCheckedChange={(checked) =>
          autoStartAck.submit(actions.run, { action: 'set_auto_start', autoStart: checked })
        }
      />
      {autoStartAck.shown && (
        <ExposureWarning
          exposure={exposure}
          ack={autoStartAck}
          testId="remote-access-auto-start-exposure"
          variant="compact"
        />
      )}
    </>
  );
}

function RestartRequiredBanner({
  status,
  onRestarted,
}: {
  status: TunnelStatusResponse;
  onRestarted: () => void;
}) {
  const { t } = useTranslation();
  const restart = useRestartGateway(undefined, onRestarted);
  if (!trustProxyRestartRequired(status)) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
      data-testid="remote-access-restart-required"
    >
      <span>
        {restart.state === 'waiting'
          ? t('settings.remoteAccess.steps.proxy.restarting')
          : restart.state === 'timeout'
            ? t('settings.remoteAccess.steps.proxy.restartTimeout')
            : t('settings.remoteAccess.steps.proxy.restartRequired')}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={restart.waiting}
        onClick={() => void restart.run()}
        data-testid="remote-access-restart-now"
      >
        {restart.waiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        {t('settings.remoteAccess.steps.proxy.restartNow')}
      </Button>
    </div>
  );
}
