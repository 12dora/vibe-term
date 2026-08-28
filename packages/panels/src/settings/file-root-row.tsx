import type { FileRootDto } from '@tmex/shared';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '@tmex/api-client';
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
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';

import { FileRootDeviceIcon } from './file-root-device-icon';
import { useFileRootDeleteMutation, useFileRootToggleMutation } from './file-root-query';

export interface FileRootRowProps {
  root: FileRootDto;
  /** 该 root 的来源 client：更新/删除沿用 */
  client: ApiClient;
  onEdit: () => void;
  onRootsMutated?: () => void;
}

export function FileRootRow({ root, client, onEdit, onRootsMutated }: FileRootRowProps) {
  const { t } = useTranslation();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const toggleMutation = useFileRootToggleMutation(client, { onRootsMutated });
  const deleteMutation = useFileRootDeleteMutation(client, { onRootsMutated });

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border p-3"
      data-testid={`settings-files-root-${root.id}`}
    >
      <Switch
        checked={root.enabled}
        disabled={toggleMutation.isPending}
        onCheckedChange={(checked) =>
          toggleMutation.mutate({ id: root.id, enabled: Boolean(checked) })
        }
        data-testid={`settings-files-root-enabled-${root.id}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileRootDeviceIcon type={root.deviceType} className="h-3.5 w-3.5 shrink-0" />
          {root.deviceName === null ? (
            <span className="text-destructive">{t('settings.files.missing')}</span>
          ) : (
            <span className="truncate">{root.deviceName}</span>
          )}
        </div>
        <div className="truncate font-mono text-xs">{root.path}</div>
        <div className="truncate text-xs text-muted-foreground">{root.name}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`settings-files-root-edit-${root.id}`}
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.delete')}
          data-testid={`settings-files-root-delete-${root.id}`}
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('settings.files.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.files.deleteDesc', { path: root.path })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid={`settings-files-root-delete-confirm-${root.id}`}
              onClick={() => {
                deleteMutation.mutate(root.id);
                setShowDeleteConfirm(false);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
