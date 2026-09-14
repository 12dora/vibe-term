// 「中继服务」段：只有本机自己在跑中继（`relay` / `relay,node`）时才出现。
//
// 这一段说的是**本机对外提供的服务**，与上面「连接」段说的「本机接到哪儿」是两件事：
// 一台中继兼节点既是运营者也是租户，两者混在一起是原来那张卡最容易误读的地方。
// 因此「接入本机中继」属于「连接」段（`uplink/uplink-section.tsx` 的 `SelfRelayEntry`），不在这里。

import type { LocalRelayStatus } from '@vibeterm/api-client/local/types';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { relayTurnStatusOf } from '../relay/relay-turn-model';
import { CopyableValue, Row } from './copy-feedback';
import { RelayServiceMetrics } from './relay/relay-service-metrics';
import { RelayTurnRow } from './relay/relay-turn-row';

export interface RelayServiceSectionProps {
  service: LocalRelayStatus;
}

/**
 * 「打开中继控制台」：顶层「中继」标签就在同一个设置页里，只换 `?tab=`，不整页跳转。
 * 与 `SettingsPage` 自己切标签走同一条路（replace 写回，不往历史里塞记录）。
 */
export function useOpenRelayConsole(): () => void {
  const [, setSearchParams] = useSearchParams();
  return useCallback(() => {
    setSearchParams(
      (params) => {
        params.set('tab', 'relay');
        return params;
      },
      { replace: true }
    );
  }, [setSearchParams]);
}

export function RelayServiceSection({ service }: RelayServiceSectionProps) {
  const { t } = useTranslation();
  const openConsole = useOpenRelayConsole();
  // 契约 §D：旧中继不下发 `turn`，这一格整块不出现。
  const turn = relayTurnStatusOf(service.turn);
  return (
    <div className="flex flex-col gap-2" data-testid="local-relay-service">
      <Row label={t('nodes.machine.relayServiceAddress')}>
        {service.publicUrl ? (
          <CopyableValue value={service.publicUrl} testId="local-relay-service-url" />
        ) : (
          <>
            <span data-testid="local-relay-service-unset">
              {t('nodes.machine.localAddressUnset')}
            </span>
            <span className="text-muted-foreground">
              {t('nodes.machine.relayServiceAddressUnsetHint')}
            </span>
          </>
        )}
        {service.hasPassword === false && (
          <span
            className="basis-full text-muted-foreground"
            data-testid="local-relay-service-password-unset"
          >
            {t('relay.admin.password.unsetWarning')}
          </span>
        )}
      </Row>

      {turn && <RelayTurnRow turn={turn} />}

      {/* 「运行」整行由指标组件自己渲染：端点不可用时它连标签一起不出。 */}
      <RelayServiceMetrics
        publicUrl={service.publicUrl}
        hasPassword={service.hasPassword}
        onOpenConsole={openConsole}
      />
    </div>
  );
}
