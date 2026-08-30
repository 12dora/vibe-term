import type { Device, FileRootDto } from '@tmex/shared';
import { Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '@tmex/api-client';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';

import {
  FileRootDeviceField,
  FileRootEnabledField,
  FileRootPathField,
} from './file-root-form-sections';
import type { FileRootDeviceGroup } from './file-root-query';
import { useFileRootForm } from './use-file-root-form';

export interface FileRootFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  /** 编辑模式下该 root 的来源 client；缺省用 runtime 的 apiClient */
  editClient?: ApiClient;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
  /** 单设备模式：设备字段只读，新增只落该设备 */
  lockedDeviceId?: string;
  onRootsMutated?: () => void;
}

export function FileRootFormModal({
  open,
  onOpenChange,
  root,
  editClient,
  devices,
  deviceGroups,
  lockedDeviceId,
  onRootsMutated,
}: FileRootFormModalProps) {
  const { t } = useTranslation();
  const form = useFileRootForm({
    open,
    root,
    editClient,
    devices,
    deviceGroups,
    lockedDeviceId,
    onOpenChange,
    onRootsMutated,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={
          form.isEdit ? `settings-files-edit-modal-${root?.id}` : 'settings-files-add-modal'
        }
      >
        <DialogHeader>
          <DialogTitle>
            {form.isEdit ? t('settings.files.modalEditTitle') : t('settings.files.modalAddTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.files.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FileRootDeviceField
            form={form}
            root={root}
            devices={devices}
            deviceGroups={deviceGroups}
          />
          <FileRootPathField form={form} />
          <FileRootEnabledField form={form} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid="settings-files-form-submit"
            onClick={form.submit}
            disabled={!form.canSubmit || form.isPending}
          >
            {form.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
