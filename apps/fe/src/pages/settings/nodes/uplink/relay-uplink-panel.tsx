// 本机卡「接入中继」面板：中继链路条、三条状态提示，以及一排摆在明面上的中继操作。
//
// 操作不再收进图标菜单：接中继、重输口令、离开中继都是低频但后果明确的动作，藏进菜单
// 只会让人找不到。非中继模式下只留一个入口（迁移 / 接入），免得在一台还没接中继的机器上
// 摆一堆点了就报「未接入中继」的按钮。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { Button } from '@tmex/ui/button';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RelayStrip, relayLabel } from '../relay/relay-strip';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { kickedRelays, reauthTarget } from './relay-targets';

export interface RelayUplinkPanelProps {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
  standalone: boolean;
  /** standalone 下的「本机作为中继 / 用密码加入」表单插槽。 */
  relaySetup?: ReactNode;
}

export function RelayUplinkPanel({
  relay,
  actions,
  standalone,
  relaySetup,
}: RelayUplinkPanelProps) {
  const { t } = useTranslation();
  if (standalone) {
    return (
      <div className="flex flex-col gap-3" data-testid="local-uplink-relay-standalone">
        <p className="text-xs text-muted-foreground">{t('nodes.machine.uplinkRelayStandalone')}</p>
        {relaySetup}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="local-uplink-relay-panel">
      {relay.relayMode ? (
        <>
          <RelayStrip
            relays={relay.ordered}
            metaEpoch={relay.metaEpoch}
            nodesViaRelay={relay.nodesViaRelay}
            quota={relay.quota}
          />
          <RelayNotices relay={relay} actions={actions} />
          {!relay.unsupported && <RelayActionButtons relay={relay} actions={actions} />}
        </>
      ) : (
        <RelayEntry relay={relay} actions={actions} />
      )}
    </div>
  );
}

/** 中继模式下的三条提示：令牌失效、元数据密钥欠账、没挂上任何一条中继。 */
function RelayNotices({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  return (
    <>
      {relay.kicked && (
        <p
          className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="nodes-relay-reauth"
        >
          <ShieldAlert className="size-3.5 shrink-0" />
          {t('relay.tenant.reauth.notice')}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => actions.openEnroll('reauth', reauthTarget(relay.ordered) ?? '')}
            data-testid="nodes-relay-reauth-action"
          >
            {t('relay.tenant.reauth.action')}
          </Button>
        </p>
      )}
      {actions.metaPending.length > 0 && (
        <p
          className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="nodes-relay-meta-pending"
        >
          <ShieldAlert className="size-3.5 shrink-0" />
          {t('relay.tenant.metaKey.pending', { count: actions.metaPending.length })}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={actions.busy}
            onClick={() => void actions.retryMetaKey()}
            data-testid="nodes-relay-meta-retry"
          >
            {t('relay.tenant.metaKey.retry')}
          </Button>
        </p>
      )}
      {!relay.writable && !relay.kicked && (
        <p
          className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
          data-testid="nodes-relay-detached"
        >
          <ShieldAlert className="size-3.5 shrink-0" />
          {t('relay.tenant.notAttached')}
        </p>
      )}
    </>
  );
}

/** 已接入中继时的一排操作；「离开中继」单独隔开，与前面几个不是一个量级。 */
function RelayActionButtons({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  const kicked = kickedRelays(relay.ordered);
  const attachedUrl = reauthTarget(relay.ordered);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => actions.openEnroll('add')}
        data-testid="nodes-relay-add"
      >
        {t('relay.tenant.actions.add')}
      </Button>
      {kicked.length > 1 ? (
        kicked.map((row) => (
          <Button
            key={`reauth-${row.url}`}
            type="button"
            size="xs"
            variant="outline"
            onClick={() => actions.openEnroll('reauth', row.url)}
            data-testid={`nodes-relay-reauth-${relayLabel(row.url)}`}
          >
            {t('relay.tenant.actions.reauthOne', { host: relayLabel(row.url) })}
          </Button>
        ))
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => actions.openEnroll('reauth', attachedUrl ?? '')}
          data-testid="nodes-relay-reauth-menu"
        >
          {t('relay.tenant.actions.reauth')}
        </Button>
      )}
      {relay.ordered.length > 1 &&
        relay.ordered.map((row) => (
          <Button
            key={`remove-${row.url}`}
            type="button"
            size="xs"
            variant="outline"
            onClick={() => actions.requestConfirm('remove', row.url)}
            data-testid={`nodes-relay-remove-${relayLabel(row.url)}`}
          >
            {t('relay.tenant.actions.removeOne', { host: relayLabel(row.url) })}
          </Button>
        ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => actions.requestConfirm('rotate')}
        data-testid="nodes-relay-rotate"
      >
        {t('relay.tenant.actions.rotate')}
      </Button>
      <span className="ml-auto">
        <Button
          type="button"
          size="xs"
          variant="destructive"
          onClick={() => actions.requestConfirm('leave')}
          data-testid="nodes-relay-leave"
        >
          {t('relay.tenant.actions.leave')}
        </Button>
      </span>
    </div>
  );
}

/** 还没接中继：hub 模式给迁移入口，没有上级时给接入入口，各配一句说明。 */
function RelayEntry({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  const migrate = relay.mode === 'hub';
  if (relay.unsupported) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="nodes-relay-unsupported">
        {t('relay.tenant.strip.empty')}
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t(migrate ? 'relay.tenant.dialog.migrateNotice' : 'relay.tenant.strip.empty')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => actions.openEnroll(migrate ? 'migrate' : 'enroll')}
          data-testid="nodes-relay-enroll"
        >
          {t(migrate ? 'relay.tenant.actions.migrate' : 'relay.tenant.actions.enroll')}
        </Button>
      </div>
    </>
  );
}
