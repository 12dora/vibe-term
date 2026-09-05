import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';

export interface RefreshConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function RefreshConfirmDialog({ open, onOpenChange, onConfirm }: RefreshConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onCancel={() => onOpenChange(false)}
      onConfirm={onConfirm}
      variant="default"
      title={t('nav.refreshPage')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('common.confirm')}
    >
      {t('nav.refreshPageConfirm')}
    </ConfirmDialog>
  );
}
