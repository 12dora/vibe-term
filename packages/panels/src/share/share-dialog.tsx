// 分享弹窗：没有进行中的分享就是创建表单，有则展示链接与终止入口。

import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShareActiveView } from './share-active-view';
import { ShareCreateForm } from './share-create-form';
import { type ShareDialogModel, useShareDialog } from './use-share-dialog';

export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  windowId: string;
  /** 缺省分享名：当前 tab 名 */
  defaultName: string;
}

function ShareDialogBody({
  model,
  onRequestStop,
}: {
  model: ShareDialogModel;
  onRequestStop: () => void;
}) {
  if (model.loading) {
    return (
      <div className="flex justify-center py-8" data-testid="share-dialog-loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (model.activeShare) {
    return (
      <ShareActiveView
        share={model.activeShare}
        password={model.createdPassword}
        stopping={model.stopping}
        onStop={onRequestStop}
      />
    );
  }
  return (
    <ShareCreateForm
      draft={model.draft}
      setField={model.setField}
      onRegeneratePassword={model.regeneratePassword}
      candidates={model.candidates}
      submitting={model.creating}
      onSubmit={model.submit}
    />
  );
}

export function ShareDialog({
  open,
  onOpenChange,
  deviceId,
  windowId,
  defaultName,
}: ShareDialogProps) {
  const { t } = useTranslation();
  const model = useShareDialog({ open, deviceId, windowId, defaultName });
  const [confirmStop, setConfirmStop] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]"
          data-testid="share-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('share.dialog.title')}</DialogTitle>
            <DialogDescription>{t('share.dialog.desc')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            <ShareDialogBody model={model} onRequestStop={() => setConfirmStop(true)} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmStop}
        title={t('share.dialog.stopConfirmTitle')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('share.dialog.stop')}
        confirmDisabled={model.stopping}
        onCancel={() => setConfirmStop(false)}
        onOpenChange={(next) => {
          if (!next) setConfirmStop(false);
        }}
        onConfirm={() => {
          setConfirmStop(false);
          model.stop();
        }}
        testId="share-stop-confirm"
        confirmTestId="share-stop-confirm-ok"
      >
        {t('share.dialog.stopConfirm')}
      </ConfirmDialog>
    </>
  );
}
