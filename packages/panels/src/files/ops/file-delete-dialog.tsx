// 删除确认：单项在标题里点名，多项列出前几个名称再补「等 N 项」。

import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';

export const FILE_DELETE_LISTED_NAMES = 5;

export interface FileDeleteDialogProps {
  open: boolean;
  names: string[];
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteNameList({ names }: { names: string[] }) {
  const { t } = useTranslation();
  const listed = names.slice(0, FILE_DELETE_LISTED_NAMES);
  const rest = names.length - listed.length;
  return (
    <ul className="text-sm" data-testid="file-delete-names">
      {listed.map((name) => (
        <li key={name} className="truncate" title={name}>
          {name}
        </li>
      ))}
      {rest > 0 ? (
        <li className="text-muted-foreground">{t('files.ops.deleteMore', { count: rest })}</li>
      ) : null}
    </ul>
  );
}

export function FileDeleteDialog(props: FileDeleteDialogProps) {
  const { open, names, busy, onConfirm, onClose } = props;
  const { t } = useTranslation();
  const title =
    names.length === 1
      ? t('files.ops.deleteTitleOne', { name: names[0] })
      : t('files.ops.deleteTitleMany', { count: names.length });
  return (
    <ConfirmDialog
      open={open}
      title={title}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('files.ops.delete')}
      variant="destructive"
      onConfirm={onConfirm}
      onCancel={onClose}
      cancelDisabled={busy}
      confirmDisabled={busy}
      confirmPending={busy}
      extra={names.length > 1 ? <DeleteNameList names={names} /> : undefined}
      testId="file-delete-dialog"
      confirmTestId="file-delete-confirm"
    >
      {t('files.ops.deleteDesc')}
    </ConfirmDialog>
  );
}
