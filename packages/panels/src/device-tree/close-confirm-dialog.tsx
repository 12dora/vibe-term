import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CloseDialogState } from './use-close-dialog';

export function CloseConfirmDialog({ state }: { state: CloseDialogState }) {
  const { t } = useTranslation();
  const { candidate, confirm, dismiss } = state;

  return (
    <ConfirmDialog
      open={candidate !== null}
      onOpenChange={(open) => !open && dismiss()}
      onConfirm={confirm}
      confirmDisabled={!candidate}
      media={<X className="h-5 w-5 text-destructive" />}
      title={
        candidate?.kind === 'pane'
          ? t('window.closePaneConfirmTitle')
          : t('window.closeConfirmTitle')
      }
      cancelLabel={t('common.cancel')}
      confirmLabel={t('common.close')}
    >
      {t('window.closeConfirmDesc', { name: candidate?.name ?? '' })}
    </ConfirmDialog>
  );
}
