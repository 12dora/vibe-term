import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { useTranslation } from 'react-i18next';
import { useWatchDialogModel, watchDialogTitleKey } from './use-watch-dialog-model';
import { WatchDeleteDialog } from './watch-delete-dialog';
import { WatchDialogContent } from './watch-dialog-content';

interface WatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
}

export function WatchDialog({ open, onOpenChange, deviceId, paneId }: WatchDialogProps) {
  const { t } = useTranslation();
  const model = useWatchDialogModel({ open, deviceId, paneId });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]"
          data-testid="watch-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t(watchDialogTitleKey(model.view))}</DialogTitle>
            <DialogDescription>
              {model.view.mode === 'list' ? t('watch.dialogDesc') : null}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto pr-1">
            <WatchDialogContent deviceId={deviceId} paneId={paneId} model={model} />
          </div>
        </DialogContent>
      </Dialog>

      <WatchDeleteDialog
        candidate={model.deleteCandidate}
        onCancel={() => model.setDeleteCandidate(null)}
        onConfirm={model.confirmDelete}
      />
    </>
  );
}
