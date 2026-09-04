// 本机卡的四段正文：连接 → 中继服务 → 网络。段与段之间只有小标题，没有折叠、没有 tab。
//
// 卡片的状态门禁（未登录 / 加载中 / 读取失败）在这里之前就分完了，进到这里一定有一份
// 完整的 `status` 与 `direct`。

import type { DomainAccessPolicy } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type {
  LocalDirectAction,
  LocalDirectStatus,
  LocalStatusResponse,
  SetupRelayRole,
} from '@tmex/api-client/local/types';
import { useTranslation } from 'react-i18next';
import { CardSection } from './card-parts';
import type { DomainAccessApi } from './domain-access-row';
import type { SetupIntent } from './membership/intent';
import { isRelayRole } from './membership/role-transition';
import { NetworkSection } from './network-section';
import { RelayServiceSection } from './relay-service-section';
import type { RestartGateway } from './restart/use-restart-now';
import type { LocalUplinkController } from './uplink/local-uplink-controller';
import { UplinkSection } from './uplink/uplink-section';

export interface LocalMachineBodyProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse;
  direct: LocalDirectStatus;
  uplink: LocalUplinkController;
  standalone: boolean;
  wizardPath: SetupIntent | null;
  wizardRelayRole: SetupRelayRole;
  selfRelayFollowUp: boolean;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
  directBusy: boolean;
  directPending: LocalDirectAction | null;
  directError: string | null;
  onDirectAction: (action: LocalDirectAction) => void;
  restartRequired: boolean;
  restart: RestartGateway;
  domainAccess: DomainAccessPolicy | null;
  domainApi: DomainAccessApi;
  onRefresh: () => void;
}

export function LocalMachineBody(props: LocalMachineBodyProps) {
  const { t } = useTranslation();
  const { status, uplink } = props;
  // 中继服务只看本机角色：一台普通节点即便接在中继上，也没有中继服务可运营。
  const service = isRelayRole(status.role) ? (status.relay ?? null) : null;
  return (
    <>
      <CardSection title={t('nodes.machine.sections.uplink')} testId="local-machine-uplink">
        <UplinkSection
          status={status}
          selfNodeId={props.mode?.nodeId ?? null}
          standalone={props.standalone}
          uplink={uplink}
          changeHubDisabled={props.changeHubDisabled}
          onChangeHub={props.onChangeHub}
          wizardPath={props.wizardPath}
          wizardRelayRole={props.wizardRelayRole}
          selfRelayFollowUp={props.selfRelayFollowUp}
        />
      </CardSection>

      {service && (
        <CardSection
          title={t('nodes.machine.sections.relayService')}
          testId="local-machine-relay-service"
        >
          <RelayServiceSection service={service} />
        </CardSection>
      )}

      <CardSection title={t('nodes.machine.sections.network')} testId="local-machine-network">
        <NetworkSection
          direct={props.direct}
          busy={props.directBusy}
          pending={props.directPending}
          directError={props.directError}
          onDirectAction={props.onDirectAction}
          restartRequired={props.restartRequired}
          restart={props.restart}
          domainAccess={props.domainAccess}
          domainApi={props.domainApi}
          onRefresh={props.onRefresh}
        />
      </CardSection>
    </>
  );
}
