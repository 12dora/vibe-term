// 切换中继的确认框。切换本身无损（make-before-break），但它改的是本机全部会话的走向，
// 所以仍要一次确认，并说清「只影响本机」。
//
// 多条中继同时挂载时改的只是**主中继**（新记录的写入方与成员名册来源），副中继照旧连着，
// 逐条链路仍按延迟自己挑路——文案因此另走一套，不能再说「改为经此中继连接」。

import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
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
export function relaySwitchDialogCopy(url: string, multiAttach = false): RelaySwitchDialogCopy {
  const params = { host: relayLabel(url) };
  if (multiAttach) {
    return {
      titleKey: 'relay.tenant.switch.primaryTitle',
      params,
      descriptionKey: 'relay.tenant.switch.primaryDescription',
      confirmKey: 'relay.tenant.switch.setPrimary',
    };
  }
  return {
    titleKey: 'relay.tenant.switch.title',
    params,
    descriptionKey: 'relay.tenant.switch.description',
    confirmKey: 'relay.tenant.switch.confirm',
  };
}

/** 切换成功的提示文案 key。 */
export function relaySwitchDoneKey(multiAttach = false): string {
  return multiAttach ? 'relay.tenant.switch.primaryDone' : 'relay.tenant.switch.done';
}

export function RelaySwitchDialog({
  controller,
  multiAttach,
}: { controller: RelaySwitchController; multiAttach?: boolean }) {
  const { t } = useTranslation();
  const target = controller.target;
  if (!target) return null;
  const copy = relaySwitchDialogCopy(target.url, multiAttach === true);
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
