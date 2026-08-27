import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CloseDialogState } from './use-close-dialog';

export function CloseConfirmDialog({ state }: { state: CloseDialogState }) {
  const { t } = useTranslation();
  const { candidate, confirm, dismiss } = state;

  return (
    <AlertDialog open={candidate !== null} onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10">
            <X className="h-5 w-5 text-destructive" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {candidate?.kind === 'pane'
              ? t('window.closePaneConfirmTitle')
              : t('window.closeConfirmTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('window.closeConfirmDesc', { name: candidate?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={!candidate} onClick={confirm}>
            {t('common.close')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
