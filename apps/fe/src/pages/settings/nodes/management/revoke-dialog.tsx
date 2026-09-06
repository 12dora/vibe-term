// 吊销（「移除节点」）的确认框：一句后果说明 + 一个可选的原因输入。
//
// 原因会签进 `revoke-node` 记录，留着日后追溯，因此不能省；但它从来不是必填项，
// 输入框留空就按空串提交，与原先弹 `prompt` 直接回车的行为一致。
//
// 确认即关框：紧随其后要弹凭据对话框（吊销每次都要用户当场确认），两个框不能叠在一起。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Input } from '@tmex/ui/input';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RevokeController, RevokePlan } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RevokeDialogCopy {
  title: string;
  body: string;
}

/**
 * 对话框的文案路由。单独导出：Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都
 * 不输出，单测只能对这份路由断言（与 `relaySwitchDialogCopy` 同一套做法）。
 */
export function revokeDialogCopy(plan: RevokePlan, t: Translate): RevokeDialogCopy {
  const count = plan.targets.length;
  const title = t('nodes.revoke.confirmTitle', { count });
  if (plan.kind === 'bulk') {
    const names = plan.targets.map((row) => row.name).join('、');
    return { title, body: t('nodes.revoke.bulkConfirm', { count, names }) };
  }
  return { title, body: t('nodes.revoke.confirmText', { name: plan.targets[0]?.name ?? '' }) };
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
    <AlertDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) controller.dismiss();
      }}
    >
      <AlertDialogContent data-testid="nodes-revoke-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium" htmlFor={reasonId}>
            {t('nodes.revoke.reasonLabel')}
          </label>
          <Input
            id={reasonId}
            value={reason}
            className="h-9"
            onChange={(event) => setReason(event.target.value)}
            data-testid="nodes-revoke-reason"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={controller.dismiss} data-testid="nodes-revoke-cancel">
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => controller.confirm(reason)}
            data-testid="nodes-revoke-ok"
          >
            {t('nodes.actions.revoke')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RevokeDialog({ controller }: { controller: RevokeController }) {
  const plan = controller.plan;
  if (!plan) return null;
  return <RevokeDialogBody plan={plan} controller={controller} />;
}
