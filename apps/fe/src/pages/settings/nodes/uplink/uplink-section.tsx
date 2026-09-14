// 「连接」段：按上级形态分派。standalone 是设置向导，mesh 分中继形态与待接入。
// 两种形态最后都接一段默认收起的「连接详情」。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { LocalStatusResponse, SetupRelayRole } from '@vibeterm/api-client/local/types';
import { Button } from '@vibeterm/ui/button';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, NoticeAction } from '../card-parts';
import { ConnectionDetails } from '../connection-details';
import type { SetupIntent } from '../membership/intent';
import { isRelayRole } from '../membership/role-transition';
import { RelayConfirmDialog, RelayEnrollDialog } from '../relay/relay-dialogs';
import { SetupWizard } from '../setup/setup-wizard';
import type { LocalUplinkController } from './local-uplink-controller';
import { RelayUplinkPanel } from './relay-uplink-panel';

export interface UplinkSectionProps {
  status: LocalStatusResponse;
  selfNodeId: string | null;
  standalone: boolean;
  uplink: LocalUplinkController;
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
  wizardPath,
  wizardRelayRole,
  selfRelayFollowUp,
}: UplinkSectionProps) {
  const { relay } = uplink;
  if (standalone)
    return <SetupSlot status={status} wizardPath={wizardPath} relayRole={wizardRelayRole} />;
  return (
    <>
      <MeshUplink status={status} uplink={uplink} selfRelayFollowUp={selfRelayFollowUp} />
      <ConnectionDetails relay={relay} selfNodeId={selfNodeId} />
      <RelayEnrollDialog actions={uplink.relayActions} />
      <RelayConfirmDialog actions={uplink.relayActions} />
    </>
  );
}

/**
 * mesh 机器的上级：中继形态与待接入互斥。
 *
 * 中继角色（`relay` / `relay,node`）还没接上自己的中继时只给一条路——接自己的中继。
 * 普通节点还没挂上任何中继时走链路面板的空态 + 加入中继 CTA。
 */
function MeshUplink({
  status,
  uplink,
  selfRelayFollowUp,
}: {
  status: LocalStatusResponse;
  uplink: LocalUplinkController;
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
      <RelayUplinkPanel relay={relay} actions={uplink.relayActions} />
      <RelayEntry relay={relay} onOpen={() => uplink.relayActions.openEnroll('enroll')} />
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
      <SetupWizard
        key={wizardPath ?? 'default'}
        localStatus={status}
        initialPath={wizardPath}
        initialRelayRole={relayRole}
      />
    </div>
  );
}

/**
 * 压根没有上级的 mesh 机器：卡面必须自己要求一个动作，因此「接入中继」留在这里。
 * 旧节点没有这族路由（`unsupported`）时整块不出现——摆一个点了必报错的按钮毫无意义。
 */
function RelayEntry({ relay, onOpen }: { relay: UseMeshRelayResult; onOpen: () => void }) {
  const { t } = useTranslation();
  if (relay.unsupported) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="default"
        onClick={onOpen}
        data-testid="nodes-relay-enroll"
      >
        {t('relay.tenant.actions.enroll')}
      </Button>
    </div>
  );
}

/** 接自己那台中继：一条提醒加一个预填好地址的按钮，全卡只此一处。 */
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
    <Notice
      tone={highlight ? 'primary' : 'muted'}
      testId="nodes-relay-self-entry"
      action={
        <NoticeAction
          label={t('nodes.machine.relayServiceEnroll')}
          testId="nodes-relay-enroll-self"
          onClick={() => onOpen(publicUrl ?? '')}
          data={{ 'data-relay-url': publicUrl ?? '' }}
        />
      }
    >
      {t('nodes.machine.relayServiceEnrollHint')}
    </Notice>
  );
}
