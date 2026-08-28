import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { useTranslation } from 'react-i18next';
import type { RenameDialogState } from './use-rename-dialog';

export function RenameDialog({ state }: { state: RenameDialogState }) {
  const { t } = useTranslation();
  const { candidate, value, setValue, confirm, resetName, dismiss } = state;

  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent data-testid="window-rename-dialog">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('window.rename')}</DialogTitle>
            <DialogDescription>{t('window.renameDesc')}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              autoFocus
              maxLength={64}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('window.renamePlaceholder')}
              data-testid="window-rename-input"
            />
          </div>
          <DialogFooter>
            {candidate?.hasCustomName && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetName}
                data-testid="window-rename-reset"
              >
                {t('window.renameReset')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={dismiss}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!value.trim()} data-testid="window-rename-save">
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
