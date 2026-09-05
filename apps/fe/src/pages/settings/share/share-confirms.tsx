// 两个破坏性操作的二次确认：终止进行中的分享、删除历史记录（连日志）。

import type { ShareRecord } from '@tmex/shared/share';
import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';

export interface ShareConfirmProps {
  /** 待确认的分享；`null` 即不展示。 */
  share: ShareRecord | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (share: ShareRecord) => void;
}

export function StopShareConfirm({ share, busy, onCancel, onConfirm }: ShareConfirmProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={share !== null}
      title={t('settings.share.active.stopTitle')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('settings.share.active.stop')}
      confirmDisabled={busy}
      testId="share-stop-confirm"
      confirmTestId="share-stop-confirm-ok"
      onCancel={onCancel}
      onConfirm={() => {
        if (share) onConfirm(share);
      }}
    >
      {t('settings.share.active.stopConfirm', { name: share?.name ?? '' })}
    </ConfirmDialog>
  );
}

export function DeleteShareConfirm({ share, busy, onCancel, onConfirm }: ShareConfirmProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={share !== null}
      title={t('settings.share.history.deleteTitle')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('common.delete')}
      confirmDisabled={busy}
      testId="share-delete-confirm"
      confirmTestId="share-delete-confirm-ok"
      onCancel={onCancel}
      onConfirm={() => {
        if (share) onConfirm(share);
      }}
    >
      {t('settings.share.history.deleteConfirm', { name: share?.name ?? '' })}
    </ConfirmDialog>
  );
}
