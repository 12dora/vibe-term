// 删除分组的二次确认。

import type { DeviceFolder } from '@vibeterm/shared';
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
} from '@vibeterm/ui/alert-dialog';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface FolderDeleteDialogProps {
  /** 待确认删除的分组；null = 对话框关着 */
  folder: DeviceFolder | null;
  onConfirm: (folderId: string) => void;
  onClose: () => void;
}

export function FolderDeleteDialog({ folder, onConfirm, onClose }: FolderDeleteDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10">
            <Trash2 className="h-5 w-5 text-destructive" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('devices.folders.deleteConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('devices.folders.deleteConfirmDescription', { name: folder?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="device-folder-delete-confirm"
            onClick={() => {
              if (folder) onConfirm(folder.id);
              onClose();
            }}
          >
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
