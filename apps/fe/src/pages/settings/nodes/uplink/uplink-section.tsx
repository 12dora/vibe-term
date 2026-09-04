// 「连接」段：按上级形态分派。standalone 是设置向导，mesh 分中继形态、中继角色待接入与
// Hub 形态，三种形态最后都接一段默认收起的「连接详情」。
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
import { isRelayRole } from '../membership/role-transition';
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
  /** 刚设置完中继兼节点：把「接入本机中继」顶到眼前。 */
  selfRelayFollowUp: boolean;
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
  selfRelayFollowUp,
}: UplinkSectionProps) {
  const { relay } = uplink;
  if (standalone)
    return <SetupSlot status={status} wizardPath={wizardPath} relayRole={wizardRelayRole} />;
  return (
    <>
      <MeshUplink
        status={status}
        selfNodeId={selfNodeId}
        uplink={uplink}
        changeHubDisabled={changeHubDisabled}
        onChangeHub={onChangeHub}
        selfRelayFollowUp={selfRelayFollowUp}
      />
      <ConnectionDetails relay={relay} hubs={uplink.hubs} selfNodeId={selfNodeId} />
      <RelayEnrollDialog actions={uplink.relayActions} />
      <RelayConfirmDialog actions={uplink.relayActions} />
    </>
  );
}

/**
 * mesh 机器的上级：三种形态互斥。
 *
 * 中继角色（`relay` / `relay,node`）还没接上自己的中继时**只给一条路**——接自己的中继。
 * 后端在这个状态下把 `mode` 报成 `hub`，照 hub 形态摆版会给出「改为接入中继 / 不再连接 Hub」，
 * 把用户引向接别人的中继，还平白说了一句它这辈子都用不上的 Hub。
 */
function MeshUplink({
  status,
  selfNodeId,
  uplink,
  changeHubDisabled,
  onChangeHub,
  selfRelayFollowUp,
}: {
  status: LocalStatusResponse;
  selfNodeId: string | null;
  uplink: LocalUplinkController;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
  selfRelayFollowUp: boolean;
}) {
  const { relay } = uplink;
  if (relay.relayMode) return <RelayUplinkPanel relay={relay} actions={uplink.relayActions} />;
  if (isRelayRole(status.role))
    return (
      <SelfRelayEntry
        relay={relay}
        publicUrl={status.relay?.publicUrl ?? null}
        highlight={selfRelayFollowUp}
        onOpen={(url) => uplink.relayActions.openEnroll('enroll', url)}
      />
    );
  return (
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

/** 接自己那台中继：一句陈述加一个预填好地址的按钮，全卡只此一处。 */
export function SelfRelayEntry({
  relay,
  publicUrl,
  highlight,
  onOpen,
}: {
  relay: UseMeshRelayResult;
  publicUrl: string | null;
  highlight: boolean;
  onOpen: (url: string) => void;
}) {
  const { t } = useTranslation();
  if (relay.unsupported) return null;
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg p-2 text-xs ${
        highlight ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-muted-foreground'
      }`}
      data-testid="nodes-relay-self-entry"
    >
      <span>{t('nodes.machine.relayServiceEnrollHint')}</span>
      <span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => onOpen(publicUrl ?? '')}
          data-testid="nodes-relay-enroll-self"
          data-relay-url={publicUrl ?? ''}
        >
          {t('nodes.machine.relayServiceEnroll')}
        </Button>
      </span>
    </div>
  );
}
