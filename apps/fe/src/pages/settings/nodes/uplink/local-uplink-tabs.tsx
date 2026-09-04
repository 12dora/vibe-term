// 本机卡里的「接入 Hub / 接入中继」两个 tab。
//
// 两个 tab 永远都能点：选中哪个只由真实上级形态决定初值，点过之后以用户的选择为准。
// 上级形态一变（接上中继、离开中继）就把当场的选择丢掉，重新跟随真实形态。

import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tmex/ui/tabs';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetupIntent } from '../membership/intent';
import { RelayConfirmDialog, RelayEnrollDialog } from '../relay/relay-dialogs';
import { HubUplinkPanel } from './hub-uplink-panel';
import type { LocalUplinkController } from './local-uplink-controller';
import { RelayUplinkPanel } from './relay-uplink-panel';
import {
  type UplinkTab,
  deriveUplinkTab,
  readUplinkTab,
  writeUplinkTab,
} from './uplink-tab-preference';

export interface LocalUplinkTabsProps {
  status: LocalStatusResponse;
  selfNodeId: string | null;
  standalone: boolean;
  uplink: LocalUplinkController;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
  /** standalone 下预选的 Hub 向导路径。 */
  wizardPath: SetupIntent | null;
  /** standalone 下「本机作为中继」表单的插槽。 */
  relaySetup?: ReactNode;
  /** 上层要求切到的 tab（角色下拉选了中继、跨重启记号）；变一次生效一次。 */
  requestedTab?: UplinkTab | null;
  /** 刚设置完中继兼节点：中继 tab 上把「接入本机中继」顶到眼前。 */
  selfRelayFollowUp?: boolean;
}

export function LocalUplinkTabs({
  status,
  selfNodeId,
  standalone,
  uplink,
  changeHubDisabled,
  onChangeHub,
  wizardPath,
  relaySetup,
  requestedTab = null,
  selfRelayFollowUp = false,
}: LocalUplinkTabsProps) {
  const { t } = useTranslation();
  const { relay } = uplink;
  const uplinkMode = relay.unsupported ? 'none' : relay.mode;
  const [remembered] = useState<UplinkTab>(() => readUplinkTab());
  const [chosen, setChosen] = useState<UplinkTab | null>(null);
  // 上级形态变了（刚接上中继 / 刚离开）就撤掉当场的选择：新的形态才是用户此刻要看的那一边。
  const [seenMode, setSeenMode] = useState(uplinkMode);
  if (seenMode !== uplinkMode) {
    setSeenMode(uplinkMode);
    setChosen(null);
  }
  // 上层的请求只在「刚提出来」那一刻覆盖选择，之后用户照样能自己切回去。
  const [seenRequest, setSeenRequest] = useState(requestedTab);
  if (seenRequest !== requestedTab) {
    setSeenRequest(requestedTab);
    if (requestedTab) setChosen(requestedTab);
  }
  const active = chosen ?? deriveUplinkTab(uplinkMode, remembered);

  return (
    <>
      <Tabs
        value={active}
        onValueChange={(next: unknown) => {
          if (next !== 'hub' && next !== 'relay') return;
          setChosen(next);
          writeUplinkTab(next);
        }}
        data-testid="local-uplink-tabs"
      >
        <TabsList variant="line">
          <TabsTrigger value="hub" data-testid="local-uplink-tab-hub">
            {t('nodes.machine.uplinkTabHub')}
          </TabsTrigger>
          <TabsTrigger value="relay" data-testid="local-uplink-tab-relay">
            {t('nodes.machine.uplinkTabRelay')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="hub" className="pt-1">
          <HubUplinkPanel
            localRole={status.role}
            selfNodeId={selfNodeId}
            status={status}
            hubs={uplink.hubs}
            hubOnline={uplink.hub.online}
            hubLoading={uplink.hub.loading}
            hubFailure={uplink.hub.failure}
            relayMode={relay.relayMode}
            standalone={standalone}
            changeHubDisabled={changeHubDisabled}
            onChangeHub={onChangeHub}
            wizardPath={wizardPath}
          />
        </TabsContent>
        <TabsContent value="relay" className="pt-1">
          <RelayUplinkPanel
            relay={relay}
            actions={uplink.relayActions}
            standalone={standalone}
            localRole={status.role}
            relayService={status.relay}
            selfRelayFollowUp={selfRelayFollowUp}
            relaySetup={relaySetup}
          />
        </TabsContent>
      </Tabs>

      <RelayEnrollDialog actions={uplink.relayActions} />
      <RelayConfirmDialog actions={uplink.relayActions} />
    </>
  );
}
