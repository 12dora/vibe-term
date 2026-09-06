// 进行中的分享：一行一条，复制链接与终止两个常用动作直接摆出来，
// 密码三件事（查看 / 修改 / 复制带密码的链接）收进行尾菜单——再加三枚按钮这一列就装不下了。
// 终止走二次确认（对方会立刻断开）。
//
// 列表跨节点汇总，行里带着自己的节点：多节点时多一列点名是哪台，单机时这一列没有信息量，不出。

import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Copy, Ellipsis, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll, stickyActionColumn } from '../components/wide-table';
import { useCopyToClipboard } from '../nodes/copy-feedback';
import {
  absoluteTimeText,
  expiresText,
  originHostText,
  relativePastText,
  shareTerminalText,
} from './share-format';
import type { SharePasswordAction } from './share-password-dialogs';
import { type ShareRow, shareRowKey } from './share-rows';
import { EmptyRow, Td, Th, TimeCell } from './table-parts';

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

export function ActiveSharesTable({
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
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('settings.share.active.columns.actions')}
                  data-testid={`share-menu-${share.id}`}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <ActiveShareMenuList
                busy={busy}
                label={(action) => t(SHARE_PASSWORD_ACTION_LABEL[action])}
                onSelect={(action) => onPasswordAction(action, share)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Td>
    </tr>
  );
}

export const SHARE_PASSWORD_ACTIONS: readonly SharePasswordAction[] = [
  'view',
  'change',
  'copy-link',
];

export const SHARE_PASSWORD_ACTION_LABEL: Record<SharePasswordAction, string> = {
  view: 'settings.share.active.viewPassword',
  change: 'settings.share.active.changePassword',
  'copy-link': 'settings.share.active.copyLinkWithPassword',
};

/** 菜单项的 testId 不带分享 id：同一时刻只会展开一个菜单，portal 里就这一份。 */
const SHARE_PASSWORD_ACTION_TEST_ID: Record<SharePasswordAction, string> = {
  view: 'share-row-view-password',
  change: 'share-row-change-password',
  'copy-link': 'share-row-copy-link-password',
};

/**
 * 菜单内容。单独导出且**不带 hook**：Base UI 的菜单走 portal，静态渲染什么都不输出，
 * 单测只能把它当普通函数调用再对元素树断言（与 `LocalMachineMenuList` 同一套做法）。
 */
export function ActiveShareMenuList({
  busy,
  label,
  onSelect,
}: {
  busy: boolean;
  label: (action: SharePasswordAction) => string;
  onSelect: (action: SharePasswordAction) => void;
}) {
  return (
    <>
      {SHARE_PASSWORD_ACTIONS.map((action) => (
        <DropdownMenuItem
          key={action}
          disabled={busy}
          onClick={() => onSelect(action)}
          data-testid={SHARE_PASSWORD_ACTION_TEST_ID[action]}
        >
          {label(action)}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function CopyLinkButton({ share }: { share: ShareRow }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyToClipboard(share.url);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={copy}
      data-testid={`share-copy-${share.id}`}
    >
      <Copy />
      {copied ? t('settings.share.active.linkCopied') : t('settings.share.active.copyLink')}
      <output className="sr-only" aria-live="polite">
        {copied ? t('settings.share.active.linkCopied') : ''}
      </output>
    </Button>
  );
}
