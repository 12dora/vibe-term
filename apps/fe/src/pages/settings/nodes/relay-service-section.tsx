// 「中继服务」段：只有本机自己在跑中继（`relay` / `relay,node`）时才出现。
//
// 这一段说的是**本机对外提供的服务**，与上面「连接」段说的「本机接到哪儿」是两件事：
// 一台中继兼节点既是运营者也是租户，两者混在一起是原来那张卡最容易误读的地方。

import type { LocalRelayStatus } from '@tmex/api-client/local/types';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { CopyableValue, Row } from './copy-feedback';
import { RelayServiceMetrics } from './relay/relay-service-metrics';
import { UnsetAddress } from './uplink/hub-uplink-panel';

export interface RelayServiceSectionProps {
  service: LocalRelayStatus;
  /** 本机还没以租户身份接上自己的中继：给一个预填好地址的接入入口。 */
  showSelfEnroll: boolean;
  /** 刚设置完中继兼节点：把入口顶到眼前。 */
  highlightSelfEnroll: boolean;
  onEnrollSelf: (url: string) => void;
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

export function RelayServiceSection({
  service,
  showSelfEnroll,
  highlightSelfEnroll,
  onEnrollSelf,
}: RelayServiceSectionProps) {
  const { t } = useTranslation();
  const openConsole = useOpenRelayConsole();
  return (
    <div className="flex flex-col gap-3" data-testid="local-relay-service">
      <Row label={t('nodes.machine.relayServiceAddress')}>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {service.publicUrl ? (
            <CopyableValue value={service.publicUrl} testId="local-relay-service-url" />
          ) : (
            <UnsetAddress
              hint={t('nodes.machine.relayServiceAddressUnsetHint')}
              testId="local-relay-service"
            />
          )}
          <Badge variant="outline" data-testid="local-relay-service-password">
            {t(service.hasPassword ? 'relay.admin.password.set' : 'relay.admin.password.unset')}
          </Badge>
        </span>
      </Row>

      <RelayServiceMetrics
        publicUrl={service.publicUrl}
        hasPassword={service.hasPassword}
        onOpenConsole={openConsole}
      />

      {showSelfEnroll && (
        <div
          className={`flex flex-col gap-2 rounded-lg p-2 text-xs ${
            highlightSelfEnroll ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-muted-foreground'
          }`}
          data-testid="nodes-relay-self-entry"
        >
          <span>{t('nodes.machine.relayServiceEnrollHint')}</span>
          <span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onEnrollSelf(service.publicUrl ?? '')}
              data-testid="nodes-relay-enroll-self"
            >
              {t('nodes.machine.relayServiceEnroll')}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
