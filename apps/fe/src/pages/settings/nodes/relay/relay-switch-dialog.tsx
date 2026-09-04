// 切换中继的确认框。切换本身无损（make-before-break），但它改的是本机全部会话的走向，
// 所以仍要一次确认，并说清「只影响本机」。

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
import { useTranslation } from 'react-i18next';
import { relayLabel } from './relay-rows';
import type { RelaySwitchController } from './use-relay-switch';

export interface RelaySwitchDialogCopy {
  titleKey: string;
  params: { host: string };
  descriptionKey: string;
  confirmKey: string;
}

/**
 * 对话框的文案路由。单独导出：Base UI 的对话框走 portal 且实现按需到货，静态渲染什么都
 * 不输出，单测只能对这份路由断言（与 `leaveDialogTitleKey` 同一套做法）。
 */
export function relaySwitchDialogCopy(url: string): RelaySwitchDialogCopy {
  return {
    titleKey: 'relay.tenant.switch.title',
    params: { host: relayLabel(url) },
    descriptionKey: 'relay.tenant.switch.description',
    confirmKey: 'relay.tenant.switch.confirm',
  };
}

export function RelaySwitchDialog({ controller }: { controller: RelaySwitchController }) {
  const { t } = useTranslation();
  const target = controller.target;
  if (!target) return null;
  const copy = relaySwitchDialogCopy(target.url);
  return (
    <AlertDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) controller.dismiss();
      }}
    >
      <AlertDialogContent data-testid="nodes-relay-switch-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(copy.titleKey, copy.params)}</AlertDialogTitle>
          <AlertDialogDescription>{t(copy.descriptionKey)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={controller.dismiss} data-testid="nodes-relay-switch-cancel">
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={controller.busy}
            onClick={() => void controller.confirm()}
            data-testid="nodes-relay-switch-ok"
          >
            {t(copy.confirmKey)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
