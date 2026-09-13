// 吊销（「移除节点」）的确认框：一句后果说明 + 一个可选的原因输入。
//
// 原因会签进 `revoke-node` 记录，留着日后追溯，因此不能省；但它从来不是必填项，
// 输入框留空就按空串提交，与原先弹 `prompt` 直接回车的行为一致。
//
// 确认即关框：紧随其后要弹凭据对话框（吊销每次都要用户当场确认），两个框不能叠在一起。

import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RevokeController, RevokePlan } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RevokeDialogCopy {
  title: string;
  body: string;
  /** 批量时逐条列出的目标；单台为空。名字不进正文：几十台时那一句会把对话框撑出视口。 */
  targets: Array<{ id: string; name: string }>;
}

/**
 * 对话框的文案路由。单独导出：Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都
 * 不输出，单测只能对这份路由断言（与 `relaySwitchDialogCopy` 同一套做法）。
 */
export function revokeDialogCopy(plan: RevokePlan, t: Translate): RevokeDialogCopy {
  const count = plan.targets.length;
  const title = t('nodes.revoke.confirmTitle', { count });
  if (plan.kind === 'bulk') {
    return {
      title,
      body: t('nodes.revoke.bulkConfirm', { count }),
      targets: plan.targets.map((row) => ({ id: row.id, name: row.name })),
    };
  }
  return {
    title,
    body: t('nodes.revoke.confirmText', { name: plan.targets[0]?.name ?? '' }),
    targets: [],
  };
}

/** 内层单独一段：每次开框都重新挂载，原因输入框不会带着上一次的残留。 */
function RevokeDialogBody({
  plan,
  controller,
}: { plan: RevokePlan; controller: RevokeController }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const copy = revokeDialogCopy(plan, t);

  return (
    <ConfirmDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) controller.dismiss();
      }}
      title={copy.title}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('nodes.actions.revoke')}
      onCancel={controller.dismiss}
      onConfirm={() => controller.confirm(reason)}
      testId="nodes-revoke-dialog"
      cancelTestId="nodes-revoke-cancel"
      confirmTestId="nodes-revoke-ok"
      contentClassName="max-h-[85vh] overflow-y-auto"
      input={{
        id: reasonId,
        label: t('nodes.revoke.reasonLabel'),
        value: reason,
        onChange: setReason,
        testId: 'nodes-revoke-reason',
      }}
    >
      {copy.body}
      {copy.targets.length > 0 && (
        // 描述区是 <p>，名字只能用行内元素铺开；台数多时这一块自己滚，不撑高对话框。
        <span className="mt-2 block max-h-32 overflow-y-auto" data-testid="nodes-revoke-targets">
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

export function RevokeDialog({ controller }: { controller: RevokeController }) {
  const plan = controller.plan;
  if (!plan) return null;
  return <RevokeDialogBody plan={plan} controller={controller} />;
}
