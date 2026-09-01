// 远程卸载的确认框：把「删什么」「哪几台卸不了、为什么」一次列清楚。
//
// 这是本页最具破坏性的动作（目标机器上的服务、程序与数据一并删掉，且不可撤销），
// 因此确认按钮上写的是「卸载」而不是「确定」，跳过的节点也要连原因一起摆出来。

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
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeUninstallController, UninstallPlan, UninstallSkipReason } from './types';

const SKIP_KEY: Record<UninstallSkipReason, string> = {
  self: 'nodes.uninstall.skip.self',
  offline: 'nodes.uninstall.skip.offline',
  loginRequired: 'nodes.uninstall.skip.loginRequired',
  tooOld: 'nodes.uninstall.skip.tooOld',
  uninstalling: 'nodes.uninstall.skip.uninstalling',
};

/** 对话框正文。单独导出：AlertDialog 走 portal，静态渲染只看得到这一块。 */
export function UninstallDialogBody({ plan }: { plan: UninstallPlan }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="nodes-uninstall-body">
      {plan.targets.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {t('nodes.uninstall.targets', { count: plan.targets.length })}
          </p>
          <ul className="flex flex-col gap-0.5">
            {plan.targets.map((row) => (
              <li
                key={row.id}
                className="truncate font-medium"
                data-testid={`nodes-uninstall-target-${row.id}`}
              >
                {row.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-destructive" data-testid="nodes-uninstall-none">
          {t('nodes.uninstall.noTargets')}
        </p>
      )}

      {plan.skipped.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {t('nodes.uninstall.skipped', { count: plan.skipped.length })}
          </p>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {plan.skipped.map(({ row, reason }) => (
              <li key={row.id} className="truncate" data-testid={`nodes-uninstall-skip-${row.id}`}>
                {row.name}｜{t(SKIP_KEY[reason])}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function UninstallDialog({ uninstall }: { uninstall: NodeUninstallController }) {
  const { t } = useTranslation();
  const { plan, running } = uninstall;
  if (!plan) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !running) uninstall.dismiss();
      }}
    >
      <AlertDialogContent data-testid="nodes-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.uninstall.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('nodes.uninstall.confirmText')}</AlertDialogDescription>
        </AlertDialogHeader>

        <UninstallDialogBody plan={plan} />

        <AlertDialogFooter>
          {!running && (
            <AlertDialogCancel onClick={uninstall.dismiss} data-testid="nodes-uninstall-cancel">
              {t('nodes.uninstall.cancel')}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            variant="destructive"
            disabled={running || plan.targets.length === 0}
            onClick={uninstall.confirm}
            data-testid="nodes-uninstall-confirm"
          >
            {running && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('nodes.uninstall.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
