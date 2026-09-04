// 「连接」段：按上级形态分派。standalone 是设置向导，mesh 分中继形态与 Hub 形态，
// 两种形态最后都接一段默认收起的「连接详情」。
//
// 以前这里是「接入 Hub / 接入中继」两个 tab 加一份 localStorage 偏好：一台机器不可能同时
// 挂 Hub 和中继，摆两个 tab 只会让另一边永远是一句「先离开中继」。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { LocalStatusResponse, SetupRelayRole } from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionDetails } from '../connection-details';
import type { SetupIntent } from '../membership/intent';
import { RelayConfirmDialog, RelayEnrollDialog } from '../relay/relay-dialogs';
import { HubSetupWizard } from '../setup/hub-setup-wizard';
import { HubUplinkPanel } from './hub-uplink-panel';
import type { LocalUplinkController } from './local-uplink-controller';
import { RelayUplinkPanel } from './relay-uplink-panel';

export interface UplinkSectionProps {
  status: LocalStatusResponse;
  selfNodeId: string | null;
  standalone: boolean;
  uplink: LocalUplinkController;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
  /** standalone 下预选的向导路径。 */
  wizardPath: SetupIntent | null;
  /** standalone 下「本机作为中继」表单的预选角色（跨重启记号带来的）。 */
  wizardRelayRole: SetupRelayRole;
}

export function UplinkSection({
  status,
  selfNodeId,
  standalone,
  uplink,
  changeHubDisabled,
  onChangeHub,
  wizardPath,
  wizardRelayRole,
}: UplinkSectionProps) {
  const { relay } = uplink;
  if (standalone)
    return <SetupSlot status={status} wizardPath={wizardPath} relayRole={wizardRelayRole} />;
  return (
    <>
      {relay.relayMode ? (
        <RelayUplinkPanel relay={relay} actions={uplink.relayActions} />
      ) : (
        <>
          <HubUplinkPanel
            localRole={status.role}
            selfNodeId={selfNodeId}
            status={status}
            hubs={uplink.hubs}
            hubOnline={uplink.hub.online}
            hubLoading={uplink.hub.loading}
            hubFailure={uplink.hub.failure}
            changeHubDisabled={changeHubDisabled}
            onChangeHub={onChangeHub}
          />
          <RelayEntry relay={relay} onOpen={(intent) => uplink.relayActions.openEnroll(intent)} />
        </>
      )}
      <ConnectionDetails relay={relay} hubs={uplink.hubs} selfNodeId={selfNodeId} />
      <RelayEnrollDialog actions={uplink.relayActions} />
      <RelayConfirmDialog actions={uplink.relayActions} />
    </>
  );
}

/** 角色菜单选完要把向导带进视野，否则看着像什么都没发生。 */
function SetupSlot({
  status,
  wizardPath,
  relayRole,
}: {
  status: LocalStatusResponse;
  wizardPath: SetupIntent | null;
  relayRole: SetupRelayRole;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (wizardPath) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [wizardPath]);
  return (
    <div ref={ref}>
      {/* `initialPath` 只在首次挂载时生效，改路径必须换 key 重新挂一次。 */}
      <HubSetupWizard
        key={wizardPath ?? 'default'}
        localStatus={status}
        initialPath={wizardPath}
        initialRelayRole={relayRole}
      />
    </div>
  );
}

/**
 * 还没接中继的 mesh 机器：hub 模式给「改为接入中继」，没有上级时给「接入中继」。
 * 旧节点没有这族路由（`unsupported`）时整块不出现——摆一个点了必报错的按钮毫无意义。
 */
function RelayEntry({
  relay,
  onOpen,
}: {
  relay: UseMeshRelayResult;
  onOpen: (intent: 'enroll' | 'migrate') => void;
}) {
  const { t } = useTranslation();
  if (relay.unsupported) return null;
  const migrate = relay.mode === 'hub';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => onOpen(migrate ? 'migrate' : 'enroll')}
        data-testid="nodes-relay-enroll"
      >
        {t(migrate ? 'relay.tenant.actions.migrate' : 'relay.tenant.actions.enroll')}
      </Button>
      <span className="text-[11px] text-muted-foreground" data-testid="nodes-relay-entry-hint">
        {t(migrate ? 'relay.tenant.dialog.migrateNotice' : 'relay.tenant.strip.empty')}
      </span>
    </div>
  );
}
