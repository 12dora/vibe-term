// 上级链路区块：hub 模式摆 `HubStrip` 与 hub 的两条提示，中继模式摆 `RelayStrip` 与中继自己的
// 提示；右侧永远是一枚「中继」菜单——hub 模式下它只有一项「改为接入中继」（迁移入口）。
//
// hub 专属的东西（主备、写入归属、admit/retire）在中继模式下一律不出现：中继没有 writer 概念，
// 摆一行「主 Hub 不可达」只会让人以为坏了。

import type { MeshHubsState } from '@/node/mesh-hubs';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Network, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HubStrip } from '../management/hub-strip';
import { RelayStrip, relayLabel } from './relay-strip';
import type { RelayActionsController } from './use-relay-actions';

export interface UplinkHubView extends Pick<MeshHubsState, 'hubs' | 'attached' | 'candidates'> {
  writerHubId: string | null;
  writesBlocked: boolean;
}

export interface UplinkNotice {
  testId: string;
  key: string;
  params?: Record<string, string>;
}

/**
 * 该对哪条中继重新输口令：被踢的那条才是要重新 enroll 的目标。
 * 一条都没被踢时退回当前挂载的那条（菜单入口手动重输口令的场景）。
 */
export function reauthTarget(relays: RelayLinkStatus[]): string | null {
  const kicked = relays.filter((relay) => relay.kicked === true);
  if (kicked.length > 0) return kicked[0]?.url ?? null;
  return relays.find((relay) => relay.attached)?.url ?? relays[0]?.url ?? null;
}

/** 被踢的中继列表；多于一条时菜单逐条列出来让用户自己选。 */
export function kickedRelays(relays: RelayLinkStatus[]): RelayLinkStatus[] {
  return relays.filter((relay) => relay.kicked === true);
}

/** 上级不可写时的那一句：中继模式说中继，hub 模式区分「备 Hub 拒写」与「主 Hub 不可达」。 */
export function uplinkBlockedHint(
  t: (key: string) => string,
  relayMode: boolean,
  writesBlocked: boolean
): string {
  if (relayMode) return t('relay.tenant.notAttached');
  return t(writesBlocked ? 'nodes.hubs.standbyNotice' : 'nodes.hubOffline');
}

export function UplinkSection({
  relay,
  hubs,
  hubOnline,
  hubNotice,
  actions,
}: {
  relay: UseMeshRelayResult;
  hubs: UplinkHubView;
  hubOnline: boolean;
  /** hub 管理面不可用时那一行提示（hub 模式专用）。 */
  hubNotice: UplinkNotice;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="nodes-uplink-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {relay.relayMode ? (
          <RelayStrip
            relays={relay.ordered}
            metaEpoch={relay.metaEpoch}
            nodesViaRelay={relay.nodesViaRelay}
            quota={relay.quota}
          />
        ) : (
          <HubStrip
            hubs={hubs.hubs}
            attachedHubId={hubs.attached?.hubNodeId ?? null}
            writerHubId={hubs.writerHubId}
            candidates={hubs.candidates}
          />
        )}
        {!relay.unsupported && <RelayActionsMenu relay={relay} actions={actions} />}
      </div>

      {relay.relayMode ? (
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
      ) : (
        <>
          {!hubOnline && !hubs.writesBlocked && (
            <p
              className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
              data-testid={hubNotice.testId}
            >
              <ShieldAlert className="size-3.5 shrink-0" />
              {t(hubNotice.key, hubNotice.params)}
            </p>
          )}
          {hubs.writesBlocked && (
            <p
              className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
              data-testid="nodes-hub-standby"
            >
              <ShieldAlert className="size-3.5 shrink-0" />
              {t('nodes.hubs.standbyNotice')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 「中继」菜单。中继模式下是三项常规操作 + 一项离开；hub / 无上级时只留迁移入口，
 * 免得在一台还没接中继的机器上摆一堆点了就报「未接入中继」的按钮。
 */
export function RelayActionsMenu({
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('relay.tenant.actions.menu')}
            title={t('relay.tenant.actions.menu')}
            data-testid="nodes-relay-menu"
          />
        }
      >
        <Network />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {relay.relayMode ? (
          <>
            <DropdownMenuItem
              onClick={() => actions.openEnroll('add')}
              data-testid="nodes-relay-add"
            >
              {t('relay.tenant.actions.add')}
            </DropdownMenuItem>
            {kicked.length > 1 ? (
              kicked.map((row) => (
                <DropdownMenuItem
                  key={`reauth-${row.url}`}
                  onClick={() => actions.openEnroll('reauth', row.url)}
                  data-testid={`nodes-relay-reauth-${relayLabel(row.url)}`}
                >
                  {t('relay.tenant.actions.reauthOne', { host: relayLabel(row.url) })}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem
                onClick={() => actions.openEnroll('reauth', attachedUrl ?? '')}
                data-testid="nodes-relay-reauth-menu"
              >
                {t('relay.tenant.actions.reauth')}
              </DropdownMenuItem>
            )}
            {relay.ordered.length > 1 &&
              relay.ordered.map((row) => (
                <DropdownMenuItem
                  key={`remove-${row.url}`}
                  onClick={() => actions.requestConfirm('remove', row.url)}
                  data-testid={`nodes-relay-remove-${relayLabel(row.url)}`}
                >
                  {t('relay.tenant.actions.removeOne', { host: relayLabel(row.url) })}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem
              onClick={() => actions.requestConfirm('rotate')}
              data-testid="nodes-relay-rotate"
            >
              {t('relay.tenant.actions.rotate')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => actions.requestConfirm('leave')}
              data-testid="nodes-relay-leave"
            >
              {t('relay.tenant.actions.leave')}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            onClick={() => actions.openEnroll(relay.mode === 'hub' ? 'migrate' : 'enroll')}
            data-testid="nodes-relay-enroll"
          >
            {t(
              relay.mode === 'hub' ? 'relay.tenant.actions.migrate' : 'relay.tenant.actions.enroll'
            )}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
