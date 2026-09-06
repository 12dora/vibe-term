// 升级前的确认框。升级会重启目标节点上的服务（本机则是当前这条访问），按破坏性操作渲染。
//
// 行内一台与批量一组共用这一个框：正文沿用原先弹 `confirm` 时的那三句，批量再把目标名字列出来。

import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';
import type { NodeUpgradeController, NodeUpgradePending } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface UpgradeConfirmCopy {
  title: string;
  body: string;
  /** 批量时列出的目标；行内为空。 */
  targets: Array<{ id: string; name: string }>;
}

/**
 * 对话框的文案路由。单独导出：Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都
 * 不输出，单测只能对这份路由断言（与 `relaySwitchDialogCopy` 同一套做法）。
 */
export function upgradeConfirmCopy(pending: NodeUpgradePending, t: Translate): UpgradeConfirmCopy {
  if (pending.kind === 'batch') {
    return {
      title: t('nodes.upgrade.confirmTitle'),
      body: t('nodes.upgrade.confirmAll', {
        count: pending.targets.length,
        version: pending.version,
      }),
      targets: pending.targets.map((row) => ({ id: row.id, name: row.name })),
    };
  }
  const { row } = pending;
  // latest 还没回来也允许开框：目标版本由入口在开跑那一刻解析。
  const version = pending.version ?? t('nodes.upgrade.latestPending');
  return {
    title: t('nodes.upgrade.confirmTitleOne', { name: row.name }),
    body: row.isSelf
      ? t('nodes.upgrade.confirmSelf', { version })
      : t('nodes.upgrade.confirmRemote', { name: row.name, version }),
    targets: [],
  };
}

export function UpgradeConfirmDialog({ upgrade }: { upgrade: NodeUpgradeController }) {
  const { t } = useTranslation();
  const pending = upgrade.pending;
  if (!pending) return null;
  const copy = upgradeConfirmCopy(pending, t);

  return (
    <ConfirmDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) upgrade.dismissPending();
      }}
      onCancel={upgrade.dismissPending}
      onConfirm={upgrade.confirmPending}
      variant="destructive"
      title={copy.title}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('nodes.upgrade.action')}
      testId="nodes-upgrade-confirm-dialog"
      cancelTestId="nodes-upgrade-confirm-cancel"
      confirmTestId="nodes-upgrade-confirm-ok"
    >
      {copy.body}
      {copy.targets.length > 0 && (
        // 描述区是 <p>，名字只能用行内元素铺开；台数多时这一块自己滚，不撑高对话框。
        <span
          className="mt-2 block max-h-32 overflow-y-auto"
          data-testid="nodes-upgrade-confirm-targets"
        >
          {copy.targets.map((target) => (
            <span key={target.id} className="block truncate font-medium text-foreground">
              {target.name}
            </span>
          ))}
        </span>
      )}
    </ConfirmDialog>
  );
}
