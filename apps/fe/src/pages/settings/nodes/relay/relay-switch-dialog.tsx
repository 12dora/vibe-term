// 切换中继的确认框。切换本身无损（make-before-break），但它改的是本机全部会话的走向，
// 所以仍要一次确认，并说清「只影响本机」。

import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { Loader2 } from 'lucide-react';
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
    <ConfirmDialog
      open
      onOpenChange={(next: boolean) => {
        // 在途期间 `dismiss` 自己会拒；这里同样不放行，Esc / 点外面都关不掉。
        if (!next) controller.dismiss();
      }}
      onCancel={controller.dismiss}
      onConfirm={() => void controller.confirm()}
      variant="default"
      cancelDisabled={controller.busy}
      confirmDisabled={controller.busy}
      title={t(copy.titleKey, copy.params)}
      cancelLabel={t('common.cancel')}
      confirmLabel={
        <>
          {controller.busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
          {t(copy.confirmKey)}
        </>
      }
      testId="nodes-relay-switch-dialog"
      cancelTestId="nodes-relay-switch-cancel"
      confirmTestId="nodes-relay-switch-ok"
    >
      {t(copy.descriptionKey)}
    </ConfirmDialog>
  );
}
