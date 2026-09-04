// 选「纯中继」前的确认：这一档重启后网页整个消失，只剩 CLI，选错了没法在网页里改回来。

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
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="setup-pure-relay-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.setup.pureRelayConfirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">{t('nodes.setup.pureRelayConfirm.description')}</span>
            <span className="mt-2 block font-mono">tmex relay status</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} data-testid="setup-pure-relay-cancel">
            {t('nodes.membership.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="setup-pure-relay-confirm-ok">
            {t('nodes.setup.pureRelayConfirm.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
