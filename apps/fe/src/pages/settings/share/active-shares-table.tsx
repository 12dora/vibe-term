// 进行中的分享：一行一条，复制链接与终止两个常用动作直接摆出来，
// 密码三件事（查看 / 修改 / 复制带密码的链接）收进行尾菜单——再加三枚按钮这一列就装不下了。
// 终止走二次确认（对方会立刻断开）。
//
// 列表跨节点汇总，行里带着自己的节点：多节点时多一列点名是哪台，单机时这一列没有信息量，不出。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import { Button } from '@vibeterm/ui/button';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll, stickyActionColumn } from '../components/wide-table';
import { ActiveSharesCardList } from './share-card-lists';
import {
  absoluteTimeText,
  expiresText,
  originHostText,
  relativePastText,
  shareTerminalText,
} from './share-format';
import type { SharePasswordAction } from './share-password-dialogs';
import { CopyLinkButton, SharePasswordMenu } from './share-row-parts';
import { type ShareRow, shareRowKey } from './share-rows';
import { EmptyRow, Td, Th, TimeCell } from './table-parts';

export {
  ActiveShareMenuList,
  CopyLinkButton,
  SHARE_PASSWORD_ACTIONS,
  SHARE_PASSWORD_ACTION_LABEL,
  SharePasswordMenu,
} from './share-row-parts';

export interface ActiveSharesTableProps {
  shares: ShareRow[];
  now: number;
  /** 正在写入的那一行（`shareRowKey`）。 */
  busyRowKey: string | null;
  /** 多节点时才有节点列。 */
  showNode: boolean;
  deviceName: (row: ShareRow) => string | null;
  onStop: (row: ShareRow) => void;
  onPasswordAction: (action: SharePasswordAction, row: ShareRow) => void;
}

export function ActiveSharesTable(props: ActiveSharesTableProps) {
  const narrow = useNarrowLayout();
  if (narrow) return <ActiveSharesCardList {...props} />;
  return <ActiveSharesWideTable {...props} />;
}

function ActiveSharesWideTable({
  shares,
  now,
  busyRowKey,
  showNode,
  deviceName,
  onStop,
  onPasswordAction,
}: ActiveSharesTableProps) {
  const { t } = useTranslation();
  return (
    <WideTableScroll>
      <table className="w-full min-w-[52rem] text-xs" data-testid="share-active-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('settings.share.active.columns.name')}</Th>
            {showNode && <Th>{t('settings.share.active.columns.node')}</Th>}
            <Th>{t('settings.share.active.columns.terminal')}</Th>
            <Th>{t('settings.share.active.columns.viewers')}</Th>
            <Th>{t('settings.share.active.columns.created')}</Th>
            <Th>{t('settings.share.active.columns.expires')}</Th>
            <Th>{t('settings.share.active.columns.address')}</Th>
            <Th className={stickyActionColumn}>{t('settings.share.active.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {shares.map((share) => (
            <ActiveRow
              key={shareRowKey(share)}
              share={share}
              now={now}
              busy={busyRowKey === shareRowKey(share)}
              showNode={showNode}
              deviceName={deviceName(share)}
              onStop={onStop}
              onPasswordAction={onPasswordAction}
            />
          ))}
          {shares.length === 0 && (
            <EmptyRow colSpan={showNode ? 8 : 7} testId="share-active-empty">
              {t('settings.share.active.empty')}
            </EmptyRow>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function ActiveRow({
  share,
  now,
  busy,
  showNode,
  deviceName,
  onStop,
  onPasswordAction,
}: {
  share: ShareRow;
  now: number;
  busy: boolean;
  showNode: boolean;
  deviceName: string | null;
  onStop: (row: ShareRow) => void;
  onPasswordAction: (action: SharePasswordAction, row: ShareRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <tr
      className="border-b border-border/60 last:border-0 hover:bg-muted/40"
      data-testid={`share-active-row-${share.id}`}
    >
      <Td className="max-w-48 truncate">{share.name}</Td>
      {showNode && (
        <Td className="max-w-36 truncate" testId={`share-node-${share.id}`} title={share.nodeName}>
          {share.nodeName}
        </Td>
      )}
      <Td className="max-w-56 truncate" title={shareTerminalText(share, deviceName)}>
        {shareTerminalText(share, deviceName)}
      </Td>
      <Td testId={`share-viewers-${share.id}`}>{share.viewers}</Td>
      <Td>
        <TimeCell
          text={relativePastText(t, share.createdAt, now)}
          title={absoluteTimeText(share.createdAt)}
        />
      </Td>
      <Td>
        <TimeCell
          text={expiresText(t, share.expiresAt, now)}
          title={absoluteTimeText(share.expiresAt)}
        />
      </Td>
      <Td className="max-w-56 truncate" title={share.url}>
        {originHostText(share.origin)}
      </Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
          <CopyLinkButton share={share} />
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => onStop(share)}
            data-testid={`share-stop-${share.id}`}
          >
            <Square />
            {t('settings.share.active.stop')}
          </Button>
          <SharePasswordMenu share={share} busy={busy} onPasswordAction={onPasswordAction} />
        </div>
      </Td>
    </tr>
  );
}
