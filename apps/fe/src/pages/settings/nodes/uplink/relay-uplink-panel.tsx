// 「连接」段的中继形态：链路行、一摞提醒、按风险分级的三组操作。
//
// 操作分三级：主按钮「追加中继」是常用且无损的；重输口令 / 轮换密钥 / 逐条移除收进次级菜单，
// 它们低频且各自带确认；「离开中继」单独摆在右侧的危险区，它会让本机与各节点一起失去上级。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Ellipsis } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Notice, NoticeAction } from '../card-parts';
import { relayNotices } from '../relay/relay-notices';
import { RelayRows } from '../relay/relay-rows';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { type RelayMenuAction, reauthTarget, relayActionMenu } from './relay-targets';

/**
 * 次级菜单的内容。单独导出且**不带 hook**：Base UI 的菜单走 portal，静态渲染什么都不输出，
 * 单测只能把它当普通函数调用再对元素树断言（与 `BulkActionsMenuList` 同一套做法）。
 */
export function RelayActionsMenuList({
  items,
  label,
  onSelect,
}: {
  items: RelayMenuAction[];
  label: (item: RelayMenuAction) => string;
  onSelect: (item: RelayMenuAction) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.testId}
          onClick={() => onSelect(item)}
          data-testid={item.testId}
        >
          {label(item)}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export interface RelayUplinkPanelProps {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
  /** hub 时代的机器改回 Hub 前必须先离开中继：这句提示挂在操作下方。 */
  showLeaveFirstHint?: boolean;
}

export function RelayUplinkPanel({
  relay,
  actions,
  showLeaveFirstHint = true,
}: RelayUplinkPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="local-uplink-relay-panel">
      <RelayRows relays={relay.ordered} />
      <RelayNoticeList relay={relay} actions={actions} />
      {!relay.unsupported && (
        <>
          <RelayActionRow relay={relay} actions={actions} />
          {showLeaveFirstHint && (
            <p className="text-[11px] text-muted-foreground" data-testid="nodes-relay-leave-first">
              {t('nodes.machine.relayLeaveFirst')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RelayNoticeList({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  const notices = relayNotices({
    kicked: relay.kicked,
    readmitPending: relay.readmitPending,
    metaPending: actions.metaPending.length,
    packPending: actions.packPending,
    writable: relay.writable,
  });
  const run = (kind: string) => {
    if (kind === 'kicked') actions.openEnroll('reauth', reauthTarget(relay.ordered) ?? '');
    else if (kind === 'readmit') void actions.readmitMembers();
    else if (kind === 'metaPending') void actions.retryMetaKey();
    else if (kind === 'packPending') void actions.retryPack();
  };
  return (
    <>
      {notices.map((notice) => (
        <Notice
          key={notice.kind}
          tone={notice.tone}
          testId={notice.testId}
          action={
            notice.action ? (
              <NoticeAction
                label={t(notice.action.key)}
                testId={notice.action.testId}
                disabled={actions.busy && notice.kind !== 'kicked'}
                onClick={() => run(notice.kind)}
              />
            ) : undefined
          }
        >
          {t(notice.key, notice.params)}
        </Notice>
      ))}
    </>
  );
}

function RelayActionRow({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  const menu = relayActionMenu(relay.ordered);
  const run = (item: RelayMenuAction) => {
    if (item.kind === 'reauth') actions.openEnroll('reauth', item.url ?? '');
    else if (item.kind === 'rotate') actions.requestConfirm('rotate');
    else actions.requestConfirm('remove', item.url);
  };
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" size="xs" variant="ghost" data-testid="nodes-relay-menu" />}
        >
          <Ellipsis />
          {t('relay.tenant.actions.menu')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <RelayActionsMenuList
            items={menu}
            label={(item) => t(item.key, item.params)}
            onSelect={run}
          />
        </DropdownMenuContent>
      </DropdownMenu>
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
