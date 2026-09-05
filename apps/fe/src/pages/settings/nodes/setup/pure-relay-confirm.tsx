// 选「纯中继」前的确认：这一档重启后网页整个消失，只剩 CLI，选错了没法在网页里改回来。

import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';

export function PureRelayConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onCancel={onCancel}
      onConfirm={onConfirm}
      variant="default"
      title={t('nodes.setup.pureRelayConfirm.title')}
      cancelLabel={t('nodes.membership.cancel')}
      confirmLabel={t('nodes.setup.pureRelayConfirm.confirm')}
      testId="setup-pure-relay-confirm"
      cancelTestId="setup-pure-relay-cancel"
      confirmTestId="setup-pure-relay-confirm-ok"
    >
      <span className="block">{t('nodes.setup.pureRelayConfirm.description')}</span>
      <span className="mt-2 block font-mono">tmex relay status</span>
    </ConfirmDialog>
  );
}
