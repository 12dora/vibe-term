import type { WatchRuleDto } from '@tmex/shared';
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

interface WatchDeleteDialogProps {
  candidate: WatchRuleDto | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function WatchDeleteDialog({ candidate, onCancel, onConfirm }: WatchDeleteDialogProps) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={candidate !== null} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <AlertDialogContent data-testid="watch-rule-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('watch.rules.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('watch.rules.deleteDesc', { name: candidate?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="watch-rule-delete-confirm"
            onClick={onConfirm}
          >
            {t('watch.rules.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
