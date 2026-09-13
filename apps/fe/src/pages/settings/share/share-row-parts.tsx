// 分享表 / 记录卡共用的行内件：密码三件事的菜单、复制链接按钮。

import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Copy, Ellipsis, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopyToClipboard } from '../nodes/copy-feedback';
import type { SharePasswordAction } from './share-password-dialogs';
import type { ShareRow } from './share-rows';

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

export function CopyLinkButton({ share }: { share: ShareRow }) {
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

/** 行尾「更多」：查看 / 修改密码、复制带密码的链接。表格与记录卡共用。 */
export function SharePasswordMenu({
  share,
  busy,
  onPasswordAction,
}: {
  share: ShareRow;
  busy: boolean;
  onPasswordAction: (action: SharePasswordAction, row: ShareRow) => void;
}) {
  const { t } = useTranslation();
  return (
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
  );
}

/** 历史行的两个动作：回放（没日志时禁用）与删除。表格与记录卡共用。 */
export function HistoryActions({
  share,
  busy,
  onReplay,
  onDelete,
}: {
  share: ShareRow;
  busy: boolean;
  onReplay: (row: ShareRow) => void;
  onDelete: (row: ShareRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={share.logBytes <= 0}
        onClick={() => onReplay(share)}
        data-testid={`share-replay-${share.id}`}
      >
        <Play />
        {t('settings.share.history.replay')}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="destructive"
        disabled={busy}
        onClick={() => onDelete(share)}
        data-testid={`share-delete-${share.id}`}
      >
        <Trash2 />
        {t('common.delete')}
      </Button>
    </>
  );
}
